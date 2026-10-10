import { describe, expect, it } from "vitest";
import { mergeText, threeWayRebase } from "./rebase";

const lines = (...items: string[]) => `${items.join("\n")}\n`;

describe("mergeText", () => {
	it("merges edits to different lines", () => {
		const base = lines("a", "b", "c", "d", "e");
		expect(mergeText(lines("A", "b", "c", "d", "e"), base, lines("a", "b", "c", "d", "E"))).toBe(lines("A", "b", "c", "d", "E"));
	});

	it("gives null when both sides changed the same line differently", () => {
		expect(mergeText(lines("a", "MINE", "c"), lines("a", "b", "c"), lines("a", "THEIRS", "c"))).toBeNull();
	});

	it("accepts the same change made on both sides", () => {
		expect(mergeText(lines("a", "SAME", "c"), lines("a", "b", "c"), lines("a", "SAME", "c"))).toBe(lines("a", "SAME", "c"));
	});

	it("keeps a missing final newline as it is", () => {
		expect(mergeText("A\nb\nc", "a\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
	});
});

describe("threeWayRebase", () => {
	const base = { "src/a.ts": lines("one", "two", "three", "four", "five"), "src/b.ts": lines("b"), "README.md": "readme\n" };

	it("applies the Intent's edits, new files and deletes when trunk has not moved", () => {
		const head = { "src/a.ts": lines("one", "TWO", "three", "four", "five"), "README.md": "readme\n", "src/new.ts": "new\n" };
		const result = threeWayRebase(base, head, base);
		expect(result.conflicts).toEqual([]);
		expect(result.files).toEqual(head);
	});

	it("keeps what trunk changed in files the Intent did not touch", () => {
		const head = { ...base, "src/b.ts": lines("B") };
		const trunk = { ...base, "README.md": "a new readme\n", "src/added-on-trunk.ts": "x\n" };
		const result = threeWayRebase(base, head, trunk);
		expect(result.conflicts).toEqual([]);
		expect(result.files).toEqual({ ...trunk, "src/b.ts": lines("B") });
	});

	it("merges non-overlapping edits to the same file", () => {
		const head = { ...base, "src/a.ts": lines("ONE", "two", "three", "four", "five") };
		const trunk = { ...base, "src/a.ts": lines("one", "two", "three", "four", "FIVE", "six") };
		const result = threeWayRebase(base, head, trunk);
		expect(result.conflicts).toEqual([]);
		expect(result.files["src/a.ts"]).toBe(lines("ONE", "two", "three", "four", "FIVE", "six"));
	});

	it("reports overlapping edits as a conflict and leaves trunk's version in place", () => {
		const head = { ...base, "src/a.ts": lines("one", "MINE", "three", "four", "five"), "src/b.ts": lines("B") };
		const trunk = { ...base, "src/a.ts": lines("one", "THEIRS", "three", "four", "five") };
		const result = threeWayRebase(base, head, trunk);
		expect(result.conflicts).toEqual(["src/a.ts"]);
		expect(result.files["src/a.ts"]).toBe(trunk["src/a.ts"]);
		expect(result.files["src/b.ts"]).toBe(lines("B")); // the rest still applies
	});

	it("deletes a file the Intent deleted when trunk left it alone", () => {
		const { "src/b.ts": _gone, ...head } = base;
		const trunk = { ...base, "README.md": "changed\n" };
		const result = threeWayRebase(base, head, trunk);
		expect(result.conflicts).toEqual([]);
		expect(result.files).toEqual({ "src/a.ts": base["src/a.ts"], "README.md": "changed\n" });
	});

	it("conflicts when the Intent deleted a file that trunk changed", () => {
		const { "src/b.ts": _gone, ...head } = base;
		const trunk = { ...base, "src/b.ts": lines("b", "more") };
		const result = threeWayRebase(base, head, trunk);
		expect(result.conflicts).toEqual(["src/b.ts"]);
		expect(result.files["src/b.ts"]).toBe(lines("b", "more"));
	});

	it("conflicts when the Intent edited a file that trunk deleted", () => {
		const head = { ...base, "src/b.ts": lines("B") };
		const { "src/b.ts": _gone, ...trunk } = base;
		expect(threeWayRebase(base, head, trunk)).toEqual({ files: trunk, conflicts: ["src/b.ts"] });
	});

	it("is fine when both deleted the same file, or both made the same edit", () => {
		const { "src/b.ts": _gone, ...withoutB } = base;
		expect(threeWayRebase(base, withoutB, withoutB)).toEqual({ files: withoutB, conflicts: [] });
		const edited = { ...base, "src/b.ts": lines("same") };
		expect(threeWayRebase(base, edited, edited)).toEqual({ files: edited, conflicts: [] });
	});

	it("conflicts when both added the same path with different content", () => {
		const result = threeWayRebase(base, { ...base, "src/new.ts": "mine\n" }, { ...base, "src/new.ts": "theirs\n" });
		expect(result.conflicts).toEqual(["src/new.ts"]);
		expect(result.files["src/new.ts"]).toBe("theirs\n");
	});

	it("ignores the Intent's own .intent/ files", () => {
		const head = { ...base, ".intent/intent.json": "{}", ".intent/notes.md": "notes" };
		const trunk = { ...base, "README.md": "changed\n" };
		expect(threeWayRebase({ ...base, ".intent/intent.json": "{\"old\":true}" }, head, trunk)).toEqual({ files: trunk, conflicts: [] });
	});

	it("does not modify its inputs", () => {
		const head = { ...base, "src/b.ts": lines("B") };
		const trunk = { ...base };
		const before = JSON.stringify([base, head, trunk]);
		threeWayRebase(base, head, trunk);
		expect(JSON.stringify([base, head, trunk])).toBe(before);
	});
});
