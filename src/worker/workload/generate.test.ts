import { describe, expect, it } from "vitest";
import { applyChanges } from "../ports/memory-repo-store";
import { diffSurface, surface, typecheck } from "../surface";
import { indexRepo } from "../symbols";
import { demoFiles } from "../testing/demo";
import { applyEdit, bodyTargets, editPaths, type EditSpec, fieldTargets, generateEdits, helperTargets, importSpecifier, mulberry32 } from "./generate";

const files = demoFiles();
const index = indexRepo(files);
const plain = (edits: ReturnType<typeof generateEdits>) => edits.map(({ spec, reads, claims, label }) => ({ spec, reads, claims, label }));

describe("mulberry32", () => {
	it("gives the same numbers for the same seed, in [0, 1)", () => {
		const a = mulberry32(7);
		const b = mulberry32(7);
		const first = Array.from({ length: 50 }, () => a());
		expect(Array.from({ length: 50 }, () => b())).toEqual(first);
		expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
		expect(new Set(first).size).toBeGreaterThan(45);
		expect(mulberry32(8)()).not.toBe(first[0]);
	});
});

describe("importSpecifier", () => {
	it("is relative, with a .js extension", () => {
		expect(importSpecifier("src/generated/w1.ts", "src/billing/currency.ts")).toBe("../billing/currency.js");
		expect(importSpecifier("src/generated/w1.ts", "src/generated/w0.ts")).toBe("./w0.js");
		expect(importSpecifier("src/generated/w1.ts", "index.ts")).toBe("../../index.js");
		expect(importSpecifier("src/a/b/c.ts", "src/a/d.ts")).toBe("../d.js");
	});
});

describe("generateEdits", () => {
	it("is deterministic: the same seed gives the same edits, and their changes", () => {
		const one = generateEdits(index, files, 60, 7, 0.1);
		const two = generateEdits(index, files, 60, 7, 0.1);
		expect(plain(two)).toEqual(plain(one));
		expect(two.map((edit) => edit.changes(files))).toEqual(one.map((edit) => edit.changes(files)));
		expect(plain(generateEdits(index, files, 60, 8, 0.1))).not.toEqual(plain(one));
		expect(one).toHaveLength(60);
	});

	it("mixes the kinds in roughly the weights asked for", () => {
		const edits = generateEdits(index, files, 1000, 3, 0.1);
		const count = (test: (spec: EditSpec) => boolean) => edits.filter((edit) => test(edit.spec)).length;
		const overlapping = count((spec) => spec.kind === "body" && spec.overlaps !== undefined);
		expect(overlapping).toBeGreaterThan(60);
		expect(overlapping).toBeLessThan(140);
		// The other 90% split 50 : 30 : 15.
		expect(count((spec) => spec.kind === "helper")).toBeGreaterThan(400);
		expect(count((spec) => spec.kind === "helper")).toBeLessThan(550);
		expect(count((spec) => spec.kind === "body" && spec.overlaps === undefined)).toBeGreaterThan(220);
		expect(count((spec) => spec.kind === "field")).toBeGreaterThan(90);
		expect(count((spec) => spec.kind === "field")).toBeLessThan(200);
	});

	it("an overlapping edit goes for a function an earlier edit touches; with rate 0 there are none", () => {
		const edits = generateEdits(index, files, 300, 5, 0.2);
		for (const edit of edits) {
			if (edit.spec.kind === "body" && edit.spec.overlaps !== undefined) {
				const earlier = edits.find((candidate) => candidate.spec.i === (edit.spec as { overlaps: number }).overlaps);
				expect(earlier?.spec).toMatchObject({ kind: "body", symbol: edit.spec.symbol });
				expect(earlier?.spec.i).toBeLessThan(edit.spec.i);
				expect(edit.label).toContain(`same function as w5_${edit.spec.overlaps}`);
			}
		}
		expect(generateEdits(index, files, 300, 5, 0).some((edit) => edit.spec.kind === "body" && edit.spec.overlaps !== undefined)).toBe(false);
	});

	it("says what each edit reads and claims", () => {
		const edits = generateEdits(index, files, 200, 11, 0.1);
		const helper = edits.find((edit) => edit.spec.kind === "helper");
		const body = edits.find((edit) => edit.spec.kind === "body");
		const field = edits.find((edit) => edit.spec.kind === "field");
		if (helper?.spec.kind !== "helper" || body?.spec.kind !== "body" || field?.spec.kind !== "field") {
			throw new Error("expected one of each kind in 200 edits");
		}
		// A helper relies on what it calls and claims only the new symbol it adds.
		expect(helper.reads).toEqual(helper.spec.uses.map((use) => use.symbol));
		expect(helper.reads.length).toBeGreaterThanOrEqual(1);
		expect(helper.spec.tag).toBe(`11_${helper.spec.i}`);
		expect(helper.claims).toEqual([{ symbol: `src/generated/w11_${helper.spec.i}.ts#w11_${helper.spec.i}`, mode: "interface" }]);
		expect(Object.keys(helper.changes(files))).toEqual([`src/generated/w11_${helper.spec.i}.ts`]);
		expect(editPaths(helper.spec)).toEqual([]);
		expect(body.claims).toEqual([{ symbol: body.spec.symbol, mode: "body" }]);
		expect(field.claims).toEqual([{ symbol: field.spec.symbol, mode: "interface" }]);
		expect(editPaths(field.spec)).toEqual([field.spec.symbol.split("#")[0]]);
	});

	it("every edit typechecks on the base, one at a time (50 random edits)", () => {
		const edits = generateEdits(index, files, 50, 42, 0.1);
		for (const edit of edits) {
			const result = typecheck(applyChanges(files, edit.changes(files)));
			expect(result.errors, edit.label).toEqual([]);
		}
	}, 120_000);

	it("all 50 also typecheck applied together, in order", () => {
		let current = files;
		for (const edit of generateEdits(index, files, 50, 42, 0.1)) {
			current = applyChanges(current, edit.changes(current));
		}
		expect(typecheck(current).errors).toEqual([]);
		expect(Object.keys(current).filter((path) => path.startsWith("src/generated/")).length).toBeGreaterThan(10);
	}, 60_000);
});

describe("each kind of edit, over every possible target", () => {
	it("a helper can wrap any exported function in the repo", () => {
		const targets = helperTargets(index);
		expect(targets.length).toBeGreaterThan(50);
		// One file calling them all, two at a time, is as good as one compile each.
		let current = files;
		targets.forEach((info, i) => {
			const next = targets[(i + 1) % targets.length] ?? info;
			current = applyChanges(current, applyEdit({ kind: "helper", i, tag: `0_${i}`, path: `src/generated/w${i}.ts`, name: `w${i}`, uses: [{ symbol: info.id, alias: "f0" }, { symbol: next.id, alias: "f1" }] }, current));
		});
		expect(typecheck(current).errors).toEqual([]);
	}, 60_000);

	it("a body edit fits every multi-line function, and changes no type surface", () => {
		const targets = bodyTargets(index);
		expect(targets.length).toBeGreaterThan(50);
		let current = files;
		targets.forEach((info, i) => {
			current = applyChanges(current, applyEdit({ kind: "body", i, tag: `0_${i}`, symbol: info.id }, current));
		});
		expect(typecheck(current).errors).toEqual([]);
		expect(diffSurface(surface(files).map, surface(current).map)).toEqual({ changed: [], added: [], removed: [] });
		// A second edit to the same function still fits.
		const twice = applyChanges(current, applyEdit({ kind: "body", i: 9999, tag: "1_9999", symbol: (targets[0] as (typeof targets)[number]).id }, current));
		expect(typecheck(twice).errors).toEqual([]);
	}, 60_000);

	it("a field edit fits every interface it is offered, and changes that interface's surface", () => {
		const targets = fieldTargets(index, files);
		expect(targets.length).toBeGreaterThan(10);
		let current = files;
		targets.forEach((info, i) => {
			current = applyChanges(current, applyEdit({ kind: "field", i, tag: `0_${i}`, symbol: info.id }, current));
		});
		expect(typecheck(current).errors).toEqual([]);
		const moved = diffSurface(surface(files).map, surface(current).map);
		expect(moved.changed).toEqual(expect.arrayContaining(targets.map((info) => info.id)));
	}, 60_000);

	it("two runs with different seeds never add the same name", () => {
		const names = (seed: number) => generateEdits(index, files, 80, seed, 0.1).flatMap((edit) => Object.values(edit.changes(files)).join("\n").match(/\b_?w\d+_\d+\b/g) ?? []);
		const a = new Set(names(1));
		expect(names(2).some((name) => a.has(name))).toBe(false);
	});

	it("refuses when its target is gone", () => {
		expect(() => applyEdit({ kind: "body", i: 1, tag: "0_1", symbol: "src/nope.ts#gone" }, files)).toThrow("src/nope.ts#gone is no longer there");
		expect(() => applyEdit({ kind: "field", i: 1, tag: "0_1", symbol: "src/auth/session.ts#verifySession" }, files)).toThrow("no longer an interface");
	});
});
