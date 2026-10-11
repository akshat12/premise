import { describe, expect, it } from "vitest";
import type { IntentStatus } from "../../shared/types";
import { countChanges, type DiffHunk, diffPhase, type FileDiff, hunkHeader, type IntentDiff, isIntentDiff, numberLines, totals, unreadable } from "./diff";

const hunk: DiffHunk = {
	oldStart: 12,
	newStart: 14,
	lines: [
		{ kind: " ", text: "a" },
		{ kind: "-", text: "b" },
		{ kind: "-", text: "c" },
		{ kind: "+", text: "B" },
		{ kind: " ", text: "d" },
	],
};
const file: FileDiff = { path: "src/a.ts", status: "modified", hunks: [hunk] };
const added: FileDiff = { path: "src/new.ts", status: "added", hunks: [{ oldStart: 0, newStart: 1, lines: [{ kind: "+", text: "x" }, { kind: "+", text: "y" }] }] };
const diff: IntentDiff = { intentId: "i3k9x0a2q", base: "b".repeat(40), head: "c".repeat(40), files: [file, added] };

describe("counting", () => {
	it("counts added and removed lines in a file and in the whole diff", () => {
		expect(countChanges(file)).toEqual({ added: 1, removed: 2 });
		expect(totals(diff)).toEqual({ files: 2, added: 3, removed: 2 });
		expect(totals({ ...diff, files: [added] })).toEqual({ files: 1, added: 2, removed: 0 });
	});

	it("counts files that were left out of a cut diff", () => {
		expect(totals({ ...diff, fileCount: 45, truncated: true }).files).toBe(45);
	});
});

describe("hunkHeader and numberLines", () => {
	it("writes the header a unified diff has", () => {
		expect(hunkHeader(hunk)).toBe("@@ -12,4 +14,3 @@");
		expect(hunkHeader(added.hunks[0] as DiffHunk)).toBe("@@ -0,0 +1,2 @@");
	});

	it("numbers removed lines by the old file and the rest by the new one", () => {
		expect(numberLines(hunk).map((line) => `${line.no}${line.kind}`)).toEqual(["14 ", "13-", "14-", "15+", "16 "]);
		expect(numberLines(added.hunks[0] as DiffHunk).map((line) => line.no)).toEqual([1, 2]);
		const deleted: DiffHunk = { oldStart: 1, newStart: 0, lines: [{ kind: "-", text: "x" }, { kind: "-", text: "y" }] };
		expect(numberLines(deleted).map((line) => line.no)).toEqual([1, 2]);
		// Lines put in after line 5 of the old file, with no context: they are lines 6 and 7 of the new one.
		const inserted: DiffHunk = { oldStart: 5, newStart: 6, lines: [{ kind: "+", text: "x" }, { kind: "+", text: "y" }] };
		expect(numberLines(inserted).map((line) => line.no)).toEqual([6, 7]);
	});
});

describe("isIntentDiff", () => {
	it("accepts a diff and refuses other shapes", () => {
		expect(isIntentDiff(diff)).toBe(true);
		expect(isIntentDiff({ ...diff, head: null, files: [] })).toBe(true);
		expect(isIntentDiff(unreadable("i3k9x0a2q"))).toBe(true);
		for (const bad of [null, [], "diff", { error: "no such Intent" }, { ...diff, files: [{ path: "a" }] }, { ...diff, files: [{ ...file, hunks: [{ ...hunk, lines: [{ kind: "?", text: "" }] }] }] }, { ...diff, head: 7 }]) {
			expect(isIntentDiff(bad)).toBe(false);
		}
	});
});

describe("diffPhase", () => {
	it("changes when the Intent pushes, is queued, lands, goes stale or is re-derived, and not in between", () => {
		const life: IntentStatus[] = ["planning", "claiming", "waiting", "claiming", "working", "submitted", "checking", "queued", "gating", "stale", "rederiving", "landed"];
		const phases = life.map(diffPhase);
		expect(phases.filter((phase, index) => phase !== phases[index - 1])).toEqual(["editing", "pushed", "queued", "stale", "rederiving", "landed"]);
		expect(diffPhase("quarantined")).toBe("pushed");
		expect(diffPhase("failed")).toBe(diffPhase("escalated"));
	});
});
