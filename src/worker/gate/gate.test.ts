import { describe, expect, it } from "vitest";
import type { Assertion, Intent, Premise } from "../../shared/types";
import { newIntent } from "../intent/client";
import { MemoryRepoStore } from "../ports/memory-repo-store";
import { type FileChanges, type FileMap, StaleHeadError } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";
import { surface, typecheck } from "../surface";
import { demoFiles, referencePatch } from "../testing/demo";
import { changesBetween, describeFailure, gateBatch, type GateDeps, gateOne, landingMessage, REFERENCE_TAMPERED, sameAsStopped } from "./gate";
import type { Standing } from "./standing";

// A small repo where every answer is easy to see.
const MATH = `export interface Money {
	amount: number;
}

export function add(a: number, b: number): number {
	return a + b;
}

export function total(items: Money[]): number {
	return items.reduce((sum, item) => add(sum, item.amount), 0);
}

export const UNUSED = 1;
`;
const REPO: FileMap = {
	"src/math.ts": MATH,
	"src/label.ts": 'export function label(name: string): string {\n\treturn "item " + name;\n}\n',
	"tests/math.test.ts": "export const tests = {};\n",
	"README.md": "# shop\n",
};
const ACCEPTANCE = [{ id: "ac1", description: "adds", testFile: "tests/math.test.ts", testName: "adds" }];

const allPass = (req: RunRequest): RunResult => ({
	tests: req.tests.map((test) => ({ ...test, ok: true, ms: 1 })),
	assertions: req.assertions.map((assertion) => ({ id: assertion.id, ok: true, ms: 1 })),
});

function harness(trunkFiles: FileMap = REPO) {
	const store = new MemoryRepoStore({ trunk: trunkFiles });
	const runs: RunRequest[] = [];
	const messages: string[] = [];
	const state = { runner: allPass, typechecks: 0, beforeCommit: undefined as (() => Promise<void>) | undefined };
	const deps: GateDeps = {
		snapshot: (repo, ref) => store.snapshot(repo, ref),
		head: (repo) => store.head(repo),
		async commitTrunk(expectedHead, changes, message) {
			await state.beforeCommit?.();
			messages.push(message);
			return store.commit("trunk", expectedHead, changes, message);
		},
		typecheck(files) {
			state.typechecks++;
			return typecheck(files);
		},
		surface,
		async run(req) {
			runs.push(req);
			return state.runner(req);
		},
	};
	let counter = 0;
	/** An Intent forked from trunk as it is now, with `changes` pushed to its fork. */
	async function intentWith(changes: FileChanges, fields: Partial<Intent> = {}): Promise<Intent> {
		const id = `i-test-${++counter}`;
		const { head } = await store.fork("trunk", id);
		const headCommit = await store.commit(id, head, changes, "work");
		return newIntent({ id, kind: "agent", taskId: "t-test", goal: "Make the shop better", acceptance: ACCEPTANCE, baseCommit: head, headCommit, status: "gating", ...fields });
	}
	const trunkEdit = async (changes: FileChanges) => store.commit("trunk", await store.head("trunk"), changes, "someone else landed");
	return { store, deps, runs, messages, state, intentWith, trunkEdit };
}

const asserted = (id: string): Premise => ({ symbol: "src/math.ts#add", source: "asserted", surfaceHash: null, state: "holding", assertion: { id, description: `premise ${id}`, code: "", imports: ["src/math.ts"] } satisfies Assertion });

describe("gateOne", () => {
	it("lands a clean Intent and reports what it ran", async () => {
		const h = harness();
		const before = await h.store.head("trunk");
		const intent = await h.intentWith({ "src/math.ts": MATH.replace("return a + b;", "return b + a;") }, { premises: [asserted("a1"), { symbol: "src/math.ts#total", source: "observed", surfaceHash: "x", state: "holding" }] });
		const { report, changedSymbols, newTrunkFiles, conflicts } = await gateOne(h.deps, intent, "rebase");

		expect(report).toMatchObject({ intentId: intent.id, path: "rebase", textConflict: false, typecheck: { ok: true, errors: [] }, tests: { passed: ["adds"], failed: [] }, assertions: { passed: ["a1"], failed: [] }, ok: true });
		expect(report.landedCommit).toBe(await h.store.head("trunk"));
		expect(report.landedCommit).not.toBe(before);
		expect(report.durationMs).toBeGreaterThanOrEqual(0);
		expect(conflicts).toEqual([]);
		// Only the body changed, so no symbol's type surface moved.
		expect(changedSymbols).toEqual([]);
		expect(newTrunkFiles).toEqual(await h.store.snapshot("trunk", "main"));
		expect(newTrunkFiles?.["src/math.ts"]).toContain("return b + a;");

		// It ran the acceptance tests and only the asserted premises, on the merged files.
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0]?.tests).toEqual([{ file: "tests/math.test.ts", name: "adds" }]);
		expect(h.runs[0]?.assertions.map((assertion) => assertion.id)).toEqual(["a1"]);
		expect(h.runs[0]?.files["src/math.ts"]).toContain("return b + a;");
		expect(h.messages).toEqual([`intent ${intent.id}: Make the shop better\n\nPremise-Intent: ${intent.id}`]);
	});

	it("reports the symbols whose type surface changed or disappeared, including ones that only mention them", async () => {
		const h = harness();
		const edited = MATH.replace("amount: number;", "amount: number;\n\tcurrency: string;").replace("\nexport const UNUSED = 1;\n", "");
		const { report, changedSymbols } = await gateOne(h.deps, await h.intentWith({ "src/math.ts": edited, "src/extra.ts": "export const EXTRA = 2;\n" }), "rebase");
		expect(report.ok).toBe(true);
		// Money changed; total takes Money[]; UNUSED is gone. `add` is untouched and EXTRA is new, so neither is listed.
		expect(changedSymbols).toEqual(["src/math.ts#Money", "src/math.ts#UNUSED", "src/math.ts#total"]);
	});

	it("does not land an Intent with a type error, and does not run its tests", async () => {
		const h = harness();
		const before = await h.store.head("trunk");
		const intent = await h.intentWith({ "src/math.ts": MATH.replace("return a + b;", 'return "sum";') });
		const { report, changedSymbols, newTrunkFiles } = await gateOne(h.deps, intent, "rebase");
		expect(report).toMatchObject({ textConflict: false, ok: false, landedCommit: null, tests: { passed: [], failed: [] } });
		expect(report.typecheck.ok).toBe(false);
		expect(report.typecheck.errors[0]).toMatch(/^src\/math\.ts:6: /);
		expect(changedSymbols).toEqual([]);
		expect(newTrunkFiles).toBeUndefined();
		expect(h.runs).toEqual([]);
		expect(await h.store.head("trunk")).toBe(before);
		expect(describeFailure(report)).toMatch(/^Typecheck failed on the new trunk: src\/math\.ts:6: /);
	});

	it("does not land when an acceptance test fails", async () => {
		const h = harness();
		const before = await h.store.head("trunk");
		h.state.runner = (req) => ({ ...allPass(req), tests: req.tests.map((test) => ({ ...test, ok: false, error: "expected 3, got 4", ms: 1 })) });
		const { report } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }, { premises: [asserted("a1")] }), "rebase");
		expect(report).toMatchObject({ textConflict: false, typecheck: { ok: true }, tests: { passed: [], failed: [{ name: "adds", error: "expected 3, got 4" }] }, assertions: { passed: ["a1"], failed: [] }, ok: false, landedCommit: null });
		expect(await h.store.head("trunk")).toBe(before);
		expect(describeFailure(report)).toBe('Acceptance check failed on the new trunk: "adds": expected 3, got 4');
	});

	it("does not land when an asserted premise fails", async () => {
		const h = harness();
		h.state.runner = (req) => ({ ...allPass(req), assertions: req.assertions.map((assertion) => ({ id: assertion.id, ok: assertion.id !== "a2", error: assertion.id === "a2" ? "it returned" : undefined, ms: 1 })) });
		const { report } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }, { premises: [asserted("a1"), asserted("a2")] }), "rebase");
		expect(report).toMatchObject({ tests: { passed: ["adds"] }, assertions: { passed: ["a1"], failed: [{ id: "a2", error: "it returned" }] }, ok: false, landedCommit: null });
		expect(describeFailure(report)).toBe("Premise a2 no longer holds: it returned");
	});

	it("does not land when the repo cannot be loaded at all", async () => {
		const h = harness();
		h.state.runner = () => ({ tests: [], assertions: [], loadError: "syntax error in src/math.ts:3" });
		const { report } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }), "rebase");
		expect(report).toMatchObject({ ok: false, landedCommit: null, tests: { failed: [{ name: "adds", error: "syntax error in src/math.ts:3" }] } });
	});

	it("rebases onto a trunk that moved, merging edits to different parts of a file", async () => {
		const h = harness();
		const intent = await h.intentWith({ "src/math.ts": MATH.replace("return a + b;", "return b + a;") });
		await h.trunkEdit({ "src/math.ts": MATH.replace("export const UNUSED = 1;", "export const UNUSED = 2;"), "src/label.ts": null });
		const { report, newTrunkFiles } = await gateOne(h.deps, intent, "rebase");
		expect(report).toMatchObject({ textConflict: false, ok: true });
		const trunk = await h.store.snapshot("trunk", "main");
		expect(trunk["src/math.ts"]).toContain("return b + a;");
		expect(trunk["src/math.ts"]).toContain("export const UNUSED = 2;");
		expect(trunk["src/label.ts"]).toBeUndefined();
		expect(newTrunkFiles).toEqual(trunk);
	});

	it("reports a text conflict without typechecking or landing", async () => {
		const h = harness();
		const intent = await h.intentWith({ "src/math.ts": MATH.replace("return a + b;", "return b + a;") });
		const trunkHead = await h.trunkEdit({ "src/math.ts": MATH.replace("return a + b;", "return a + b + 0;") });
		const { report, conflicts, changedSymbols } = await gateOne(h.deps, intent, "rebase");
		expect(report).toMatchObject({ textConflict: true, typecheck: { ok: false, errors: [] }, tests: { passed: [], failed: [] }, ok: false, landedCommit: null });
		expect(conflicts).toEqual(["src/math.ts"]);
		expect(changedSymbols).toEqual([]);
		expect(h.state.typechecks).toBe(0);
		expect(h.runs).toEqual([]);
		expect(await h.store.head("trunk")).toBe(trunkHead);
		expect(describeFailure(report, conflicts)).toBe("Text conflict with trunk in src/math.ts");
	});

	it("starts again once if trunk moves between the check and the commit", async () => {
		const h = harness();
		const intent = await h.intentWith({ "README.md": "# shop!\n" });
		let sneaked = 0;
		h.state.beforeCommit = async () => {
			if (sneaked++ === 0) {
				await h.trunkEdit({ "src/label.ts": 'export function label(name: string): string {\n\treturn "thing " + name;\n}\n' });
			}
		};
		const { report } = await gateOne(h.deps, intent, "rebase");
		expect(report.ok).toBe(true);
		expect(h.state.typechecks).toBe(2); // the whole pipeline ran twice
		const trunk = await h.store.snapshot("trunk", "main");
		expect(trunk["README.md"]).toBe("# shop!\n");
		expect(trunk["src/label.ts"]).toContain("thing ");
	});

	it("gives up if trunk moves a second time", async () => {
		const h = harness();
		const intent = await h.intentWith({ "README.md": "# shop!\n" });
		let n = 0;
		h.state.beforeCommit = async () => void (await h.trunkEdit({ "src/extra.ts": `export const N = ${n++};\n` }));
		await expect(gateOne(h.deps, intent, "rebase")).rejects.toBeInstanceOf(StaleHeadError);
		expect(h.state.typechecks).toBe(2);
		expect((await h.store.snapshot("trunk", "main"))["README.md"]).toBe("# shop\n");
	});

	it("can skip the tests and the assertions (the A/B baseline)", async () => {
		const h = harness();
		h.state.runner = () => {
			throw new Error("the runner must not be called");
		};
		const { report } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }, { premises: [asserted("a1")] }), "baseline", { skipTests: true, skipAssertions: true });
		expect(report).toMatchObject({ path: "baseline", ok: true, tests: { passed: [], failed: [] }, assertions: { passed: [], failed: [] } });
		expect(h.runs).toEqual([]);
	});

	it("a dry run checks everything and commits nothing", async () => {
		const h = harness();
		const before = await h.store.head("trunk");
		const good = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }, { premises: [asserted("a1")] }), "rebase", { dryRun: true });
		expect(good.report).toMatchObject({ ok: true, landedCommit: null, tests: { passed: ["adds"] }, assertions: { passed: ["a1"] } });
		expect(good.newTrunkFiles).toBeUndefined();
		expect(good.changedSymbols).toEqual([]);
		expect(h.messages).toEqual([]);
		expect(await h.store.head("trunk")).toBe(before);

		h.state.runner = (req) => ({ ...allPass(req), tests: req.tests.map((test) => ({ ...test, ok: false, error: "no", ms: 1 })) });
		const bad = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop?\n" }), "rebase", { dryRun: true });
		expect(bad.report).toMatchObject({ ok: false, landedCommit: null });
	});

	it("makes no commit when the Intent's work is already on trunk", async () => {
		const h = harness();
		const intent = await h.intentWith({ "README.md": "# shop!\n" });
		const trunkHead = await h.trunkEdit({ "README.md": "# shop!\n" });
		const { report, changedSymbols } = await gateOne(h.deps, intent, "rebase");
		expect(report).toMatchObject({ ok: true, landedCommit: trunkHead });
		expect(changedSymbols).toEqual([]);
		expect(h.messages).toEqual([]);
	});

	it("never lands the Intent's .intent/ files", async () => {
		const h = harness();
		await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n", ".intent/intent.json": "{}" }), "rebase");
		expect(Object.keys(await h.store.snapshot("trunk", "main")).filter((path) => path.startsWith(".intent/"))).toEqual([]);
	});

	it("refuses an Intent that has pushed nothing", async () => {
		const h = harness();
		const intent = await h.intentWith({ "README.md": "# shop!\n" }, { headCommit: null });
		await expect(gateOne(h.deps, intent, "rebase")).rejects.toThrow(/nothing pushed/);
	});
});

describe("gateOne with standing checks", () => {
	const landedTest = { file: "tests/label.test.ts", name: "labels items" };
	const withLandedTest = { ...REPO, "tests/label.test.ts": "export const tests = {};\n" };
	const standing: Standing[] = [{ intentId: "ilanded01", tests: [landedTest], assertions: [{ symbol: "src/label.ts#label", assertion: { id: "s1", description: "label starts with item", code: "", imports: ["src/label.ts"] } }] }];

	it("runs the landed checks with the Intent's own, and lands when they pass", async () => {
		const h = harness(withLandedTest);
		const { report, standingFailures, retired } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }), "rebase", { standing });
		expect(report).toMatchObject({ ok: true, tests: { passed: ["adds"], failed: [] }, assertions: { passed: [], failed: [] } });
		expect([standingFailures, retired]).toEqual([[], []]);
		expect(h.runs[0]?.tests).toEqual([{ file: "tests/math.test.ts", name: "adds" }, landedTest]);
		expect(h.runs[0]?.assertions.map((item) => item.id)).toEqual(["landed:ilanded01:s1"]);
	});

	it("does not land an Intent that makes a landed acceptance check fail, and says whose", async () => {
		const h = harness(withLandedTest);
		const before = await h.store.head("trunk");
		h.state.runner = (req) => ({
			tests: req.tests.map((test) => ({ ...test, ok: test.name !== "labels items", error: test.name === "labels items" ? 'expected "item a", got "thing a"' : undefined, ms: 1 })),
			assertions: req.assertions.map((item) => ({ id: item.id, ok: false, error: "it did not", ms: 1 })),
		});
		const { report, standingFailures } = await gateOne(h.deps, await h.intentWith({ "src/label.ts": 'export function label(name: string): string {\n\treturn "thing " + name;\n}\n' }), "rebase", { standing });
		expect(report).toMatchObject({ ok: false, landedCommit: null, tests: { passed: ["adds"] }, assertions: { passed: [], failed: [] } });
		expect(report.tests.failed).toEqual([{ name: "labels items", error: '(acceptance check of landed Intent ilanded01) expected "item a", got "thing a"' }]);
		expect(standingFailures).toEqual([{ intentId: "ilanded01", tests: [{ name: "labels items", error: 'expected "item a", got "thing a"' }], relied: ["label starts with item"] }]);
		expect(describeFailure(report, [], standingFailures)).toBe('Breaks landed Intent ilanded01: its acceptance check "labels items" fails (expected "item a", got "thing a"). It relied on: label starts with item.');
		expect(await h.store.head("trunk")).toBe(before);
	});

	it("does not land an Intent that edits or deletes a landed acceptance test", async () => {
		const h = harness(withLandedTest);
		for (const change of ['export const tests = { "labels items": () => {} };\n', null]) {
			const { report, standingFailures } = await gateOne(h.deps, await h.intentWith({ "tests/label.test.ts": change }), "rebase", { standing });
			expect(report.ok).toBe(false);
			expect(standingFailures[0]?.tests[0]?.error).toContain("cannot be edited");
		}
		expect(h.runs.every((run) => !run.tests.some((test) => test.name === "labels items"))).toBe(true);
	});

	it("lands an Intent that changes what a landed Intent relied on but keeps its checks passing, and retires the assertion", async () => {
		const h = harness(withLandedTest);
		h.state.runner = (req) => ({ ...allPass(req), assertions: req.assertions.map((item) => ({ id: item.id, ok: false, error: "it did not", ms: 1 })) });
		const { report, retired, standingFailures } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }), "rebase", { standing });
		expect(report).toMatchObject({ ok: true, assertions: { passed: [], failed: [] } });
		expect(standingFailures).toEqual([]);
		expect(retired).toEqual([{ intentId: "ilanded01", assertionId: "s1", description: "label starts with item" }]);
	});

	it("runs the landed checks even for an Intent with no checks of its own", async () => {
		const h = harness(withLandedTest);
		h.state.runner = (req) => ({ ...allPass(req), tests: req.tests.map((test) => ({ ...test, ok: false, error: "broken", ms: 1 })) });
		const { report } = await gateOne(h.deps, await h.intentWith({ "README.md": "# shop!\n" }, { acceptance: [] }), "rebase", { standing, skipAssertions: true });
		expect(report.ok).toBe(false);
		expect(h.runs).toHaveLength(1);
	});
});

describe("gateBatch", () => {
	const helper = (name: string) => `export const ${name} = 1;\n`;
	const plainIntent = (h: ReturnType<typeof harness>, changes: FileChanges, fields: Partial<Intent> = {}) => h.intentWith(changes, { acceptance: [], kind: "workload", ...fields });

	it("lands several Intents as one commit, with a trailer for each", async () => {
		const h = harness();
		const a = await plainIntent(h, { "src/gen/a.ts": helper("a") });
		const b = await plainIntent(h, { "src/math.ts": MATH.replace("return a + b;", "return b + a;") });
		const c = await plainIntent(h, { "src/gen/c.ts": helper("c") });
		const before = await h.store.head("trunk");
		const outcome = await gateBatch(h.deps, [a, b, c]);

		expect(outcome).toMatchObject({ conflicted: [], deferred: [] });
		expect(outcome.landed).toMatchObject({ trunkBefore: before, members: [a.id, b.id, c.id], changedSymbols: [], changedBy: {} });
		expect(outcome.landed?.commit).toBe(await h.store.head("trunk"));
		expect(outcome.landed?.reports.map((report) => [report.intentId, report.ok, report.landedCommit === outcome.landed?.commit])).toEqual([[a.id, true, true], [b.id, true, true], [c.id, true, true]]);
		// One typecheck, one commit, and no isolate run (nothing to test).
		expect(h.state.typechecks).toBe(1);
		expect(h.messages).toEqual([`batch of 3 workload intents\n\nPremise-Intent: ${a.id}\nPremise-Intent: ${b.id}\nPremise-Intent: ${c.id}`]);
		expect(h.runs).toEqual([]);
		const trunk = await h.store.snapshot("trunk", "main");
		expect([trunk["src/gen/a.ts"], trunk["src/gen/c.ts"]]).toEqual([helper("a"), helper("c")]);
		expect(trunk["src/math.ts"]).toContain("return b + a;");
		expect(outcome.landed?.newTrunkFiles).toEqual(trunk);
	});

	it("leaves out a member that conflicts with an earlier one, for a run of its own", async () => {
		const h = harness();
		const first = await plainIntent(h, { "src/math.ts": MATH.replace("return a + b;", "return b + a;") });
		const clash = await plainIntent(h, { "src/math.ts": MATH.replace("return a + b;", "return a + b + 0;") });
		const other = await plainIntent(h, { "src/gen/o.ts": helper("o") });
		const outcome = await gateBatch(h.deps, [first, clash, other]);
		expect(outcome.landed?.members).toEqual([first.id, other.id]);
		expect(outcome.conflicted).toEqual([clash.id]);
	});

	it("says which member changed which type surface, including symbols that changed only by mentioning one", async () => {
		const h = harness();
		const widen = (field: string) => MATH.replace("amount: number;", `amount: number;\n\t${field}?: number;`);
		const one = await plainIntent(h, { "src/math.ts": widen("_w1") }, { claims: [{ symbol: "src/math.ts#Money", mode: "interface" }] });
		const two = await plainIntent(h, { "src/label.ts": 'export function label(name: string, loud?: boolean): string {\n\treturn "item " + name + String(loud ?? "");\n}\n' }, { claims: [{ symbol: "src/label.ts#label", mode: "interface" }] });
		// A claim on the interface of a symbol that does not exist yet (a new helper) changes no existing surface.
		const fresh = await plainIntent(h, { "src/gen/n.ts": helper("n") }, { claims: [{ symbol: "src/gen/n.ts#n", mode: "interface" }] });
		const body = await plainIntent(h, { "README.md": "# shop!\n" });
		const outcome = await gateBatch(h.deps, [one, two, fresh, body]);
		expect(outcome.landed?.members).toEqual([one.id, two.id, fresh.id, body.id]);
		expect(outcome.deferred).toEqual([]);
		expect(outcome.landed?.changedSymbols).toEqual(["src/label.ts#label", "src/math.ts#Money", "src/math.ts#total"]);
		// `total` takes Money[]: it changed because Money did, so it is put down to the member that changed Money.
		expect(outcome.landed?.changedBy).toEqual({ "src/math.ts#Money": one.id, "src/math.ts#total": one.id, "src/label.ts#label": two.id });
	});

	it("lands nothing when the merged result does not typecheck, so the members can be gated singly", async () => {
		const h = harness();
		const before = await h.store.head("trunk");
		const good = await plainIntent(h, { "src/gen/a.ts": helper("a") });
		const bad = await plainIntent(h, { "src/gen/b.ts": 'export const b: number = "no";\n' });
		const outcome = await gateBatch(h.deps, [good, bad]);
		expect(outcome.landed).toBeNull();
		expect(outcome.reason).toMatch(/^typecheck failed: src\/gen\/b\.ts:1: /);
		expect(await h.store.head("trunk")).toBe(before);
	});

	it("runs the landed Intents' checks once for the batch, and lands nothing if one fails", async () => {
		const withTest = { ...REPO, "tests/label.test.ts": "export const tests = {};\n" };
		const standing: Standing[] = [{ intentId: "ilanded01", tests: [{ file: "tests/label.test.ts", name: "labels items" }], assertions: [] }];
		const h = harness(withTest);
		const members = [await plainIntent(h, { "src/gen/a.ts": helper("a") }), await plainIntent(h, { "src/gen/b.ts": helper("b") })];
		expect((await gateBatch(h.deps, members, { standing })).landed?.members).toHaveLength(2);
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0]?.tests).toEqual([{ file: "tests/label.test.ts", name: "labels items" }]);

		h.state.runner = (req) => ({ ...allPass(req), tests: req.tests.map((test) => ({ ...test, ok: false, error: "broken", ms: 1 })) });
		const again = [await plainIntent(h, { "src/gen/c.ts": helper("c") }), await plainIntent(h, { "src/gen/d.ts": helper("d") })];
		const outcome = await gateBatch(h.deps, again, { standing });
		expect(outcome.landed).toBeNull();
		expect(outcome.reason).toContain("Breaks landed Intent ilanded01");
	});

	it("refuses a member that has checks of its own: those get a gate run to themselves", async () => {
		const h = harness();
		const withChecks = await h.intentWith({ "src/gen/a.ts": helper("a") });
		expect(await gateBatch(h.deps, [withChecks])).toEqual({ landed: null, conflicted: [], deferred: [], reason: "a member has checks of its own" });
	});
});

describe("gateOne on the demo repo", () => {
	it("lands t01 without reporting verifySession as changed: its type surface is the same", async () => {
		const h = harness(demoFiles());
		const intent = await h.intentWith(referencePatch("t01"), { acceptance: [] });
		const { report, changedSymbols } = await gateOne(h.deps, intent, "rebase", { skipTests: true });
		expect(report.ok).toBe(true);
		expect(changedSymbols).not.toContain("src/auth/session.ts#verifySession");
		expect(changedSymbols).toEqual([]);
	});

	it("rebases t02 onto trunk after t01 with no text conflict and no type error", async () => {
		const h = harness(demoFiles());
		const t02 = await h.intentWith(referencePatch("t02"), { acceptance: [] });
		await gateOne(h.deps, await h.intentWith(referencePatch("t01"), { acceptance: [] }), "rebase", { skipTests: true });
		const { report } = await gateOne(h.deps, t02, "rebase", { skipTests: true });
		// With nothing but a rebase and a typecheck, the broken combination lands. The workers test
		// runs the same thing with the real runner, where the acceptance test stops it.
		expect(report).toMatchObject({ textConflict: false, typecheck: { ok: true, errors: [] }, ok: true });
	});
});

describe("helpers", () => {
	it("landingMessage uses the first line of the goal and adds the trailer", () => {
		expect(landingMessage({ id: "iabc12345", goal: "  Round tax to even\nmore detail" })).toBe("intent iabc12345: Round tax to even\n\nPremise-Intent: iabc12345");
	});

	it("changesBetween lists edits, additions and deletions", () => {
		expect(changesBetween({ a: "1", b: "2", c: "3" }, { a: "1", b: "two", d: "4" })).toEqual({ b: "two", c: null, d: "4" });
		expect(changesBetween({ a: "1" }, { a: "1" })).toEqual({});
	});
});

describe("gateOne: what the agent cannot write", () => {
	const REFERENCE = "premise/hidden-tests/t-test.test.ts";
	const WITH_REFERENCE: FileMap = { ...REPO, [REFERENCE]: 'export const tests = { "adds": () => {} };\n', "tests/label.test.ts": 'export const tests = { "labels an item": () => {}, "labels nothing": () => {} };\n' };
	const failing = (file: string, name: string, error: string) => (req: RunRequest): RunResult => ({
		tests: req.tests.map((test) => (test.file === file && test.name === name ? { ...test, ok: false, error, ms: 1 } : { ...test, ok: true, ms: 1 })),
		assertions: [],
	});

	it("runs the task's reference checks from trunk and every test already on trunk, and reports them apart from its own", async () => {
		const h = harness(WITH_REFERENCE);
		const intent = await h.intentWith({ "src/label.ts": 'export function label(name: string): string {\n\treturn "thing " + name;\n}\n' });
		const { report } = await gateOne(h.deps, intent, "rebase");
		expect(report.ok).toBe(true);
		expect(h.runs[0]?.tests).toEqual([
			{ file: "tests/math.test.ts", name: "adds" },
			{ file: REFERENCE, name: "adds" },
			{ file: "tests/label.test.ts", name: "labels an item" },
			{ file: "tests/label.test.ts", name: "labels nothing" },
		]);
		expect(report.tests.passed).toEqual(["adds"]);
		expect(report.reference).toEqual({ passed: ["adds"], failed: [] });
		expect(report.suite).toEqual({ passed: 2, failed: [] });
	});

	it("does not land work whose own test passes but whose reference check fails", async () => {
		const h = harness(WITH_REFERENCE);
		h.state.runner = failing(REFERENCE, "adds", "expected 3, got 4");
		const before = await h.store.head("trunk");
		const intent = await h.intentWith({ "tests/math.test.ts": 'export const tests = { "adds": () => {} };\n' });
		const { report } = await gateOne(h.deps, intent, "rebase");
		expect(report.ok).toBe(false);
		expect(report.tests).toEqual({ passed: ["adds"], failed: [] });
		expect(report.reference?.failed).toEqual([{ name: "adds", error: "expected 3, got 4" }]);
		expect(describeFailure(report)).toBe('Reference check failed on the new trunk: "adds": expected 3, got 4');
		expect(await h.store.head("trunk")).toBe(before);
	});

	it("does not land work that changes the reference file, and does not run the changed copy", async () => {
		const h = harness(WITH_REFERENCE);
		const intent = await h.intentWith({ [REFERENCE]: 'export const tests = { "adds": () => { /* easier */ } };\n' });
		const { report } = await gateOne(h.deps, intent, "rebase");
		expect(report.ok).toBe(false);
		expect(report.reference?.failed).toEqual([{ name: "adds", error: REFERENCE_TAMPERED }]);
		expect(h.runs.every((run) => !run.tests.some((test) => test.file === REFERENCE))).toBe(true);
	});

	it("does not land work that breaks a test already on trunk", async () => {
		const h = harness(WITH_REFERENCE);
		h.state.runner = failing("tests/label.test.ts", "labels an item", 'expected "item a", got "thing a"');
		const intent = await h.intentWith({ "src/label.ts": 'export function label(name: string): string {\n\treturn "thing " + name;\n}\n' });
		const { report } = await gateOne(h.deps, intent, "rebase");
		expect(report.ok).toBe(false);
		expect(report.suite).toEqual({ passed: 1, failed: [{ name: "tests/label.test.ts: labels an item", error: 'expected "item a", got "thing a"' }] });
		expect(describeFailure(report)).toBe('Breaks a test that is already on trunk: "tests/label.test.ts: labels an item": expected "item a", got "thing a"');
	});

	it("runs no tests of any kind for the comparison rule that lands on typecheck alone", async () => {
		const h = harness(WITH_REFERENCE);
		const intent = await h.intentWith({ "README.md": "# shop!\n" });
		const { report } = await gateOne(h.deps, intent, "baseline", { skipTests: true, skipAssertions: true });
		expect(report.ok).toBe(true);
		expect(h.runs).toEqual([]);
		expect(report.reference).toBeUndefined();
		expect(report.suite).toBeUndefined();
	});

	it("runs trunk's tests once for a batch, and lands none of it if one breaks", async () => {
		const h = harness(WITH_REFERENCE);
		const members = [await h.intentWith({ "README.md": "# shop 1\n" }, { acceptance: [], kind: "workload" }), await h.intentWith({ "src/label.ts": 'export function label(name: string): string {\n\treturn "thing " + name;\n}\n' }, { acceptance: [], kind: "workload" })];
		const landed = await gateBatch(h.deps, members);
		expect(landed.landed?.members).toHaveLength(2);
		expect(h.runs).toHaveLength(1);
		expect(landed.landed?.reports[0]?.suite).toEqual({ passed: 2, failed: [] });

		const again = harness(WITH_REFERENCE);
		again.state.runner = failing("tests/label.test.ts", "labels nothing", "boom");
		const more = [await again.intentWith({ "README.md": "# shop 2\n" }, { acceptance: [], kind: "workload" }), await again.intentWith({ "README.md": "# shop 3\n", "src/label.ts": 'export function label(name: string): string {\n\treturn name;\n}\n' }, { acceptance: [], kind: "workload" })];
		const outcome = await gateBatch(again.deps, more);
		expect(outcome.landed).toBeNull();
		expect(outcome.reason).toContain('breaks a test that is already on trunk: "tests/label.test.ts: labels nothing"');
	});
});

describe("sameAsStopped", () => {
	const base: FileMap = { "src/a.ts": "a0", "src/b.ts": "b0", "tests/a.test.ts": "t0", "README.md": "r" };

	it("is the changed source paths when the redo is byte for byte the stopped attempt", () => {
		const stopped: FileMap = { ...base, "src/a.ts": "a1", "tests/a.test.ts": "t1" };
		// The redo rewrote its tests and made exactly the same change to the source.
		const redo: FileMap = { ...base, "src/a.ts": "a1", "tests/a.test.ts": "t2-easier" };
		expect(sameAsStopped(base, redo, stopped)).toEqual(["src/a.ts"]);
	});

	it("is null as soon as one changed source file differs from the stopped attempt", () => {
		const stopped: FileMap = { ...base, "src/a.ts": "a1" };
		expect(sameAsStopped(base, { ...base, "src/a.ts": "a2" }, stopped)).toBeNull();
		expect(sameAsStopped(base, { ...base, "src/a.ts": "a1", "src/b.ts": "b1" }, stopped)).toBeNull();
	});

	it("is null when the stopped attempt never changed the file (it was stopped before it pushed)", () => {
		expect(sameAsStopped(base, { ...base, "src/a.ts": "a1" }, base)).toBeNull();
	});

	it("is null when the redo changed no source at all, and ignores tests and Premise's own files", () => {
		expect(sameAsStopped(base, { ...base, "tests/a.test.ts": "t1", "premise/x.json": "{}", ".intent/i.json": "{}" }, { ...base, "tests/a.test.ts": "t1" })).toBeNull();
		expect(sameAsStopped(base, base, base)).toBeNull();
	});

	it("says so in words the agent can act on", () => {
		const report = { intentId: "i1", path: "rederive" as const, textConflict: false, typecheck: { ok: true, errors: [] }, tests: { passed: [], failed: [] }, assertions: { passed: [], failed: [] }, unchanged: ["src/auth/rate-limit.ts"], ok: false, landedCommit: null, durationMs: 0 };
		expect(describeFailure(report)).toBe("The redone work is the same as the work that was stopped (src/auth/rate-limit.ts is unchanged from that attempt), so it still rests on what broke. Read how the code you rely on behaves now, and change your code to fit it.");
	});
});
