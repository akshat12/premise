import { describe, expect, it } from "vitest";
import type { IntentStatus } from "../../shared/types";
import { changesTail, countChanges, type DiffHunk, diffPhase, emptyReason, type FileDiff, hunkHeader, type IntentDiff, isIntentDiff, numberLines, totals, unreadable } from "./diff";

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

describe("what the Changes column says about where a diff comes from", () => {
	const empty: IntentDiff = { ...diff, files: [] };

	it("has nothing to explain when there are files to show", () => {
		for (const from of ["live", "recording", "past-run"] as const) {
			expect(emptyReason(diff, from)).toBeNull();
		}
	});

	it("says why there is nothing, differently for a live board, a recording and a past run", () => {
		expect(emptyReason(null, "live")).toBe("Nothing pushed yet.");
		expect(emptyReason(null, "recording")).toMatch(/recording does not include/);
		// A past run keeps only trunk, so an Intent that never landed has nothing to show.
		expect(emptyReason(null, "past-run")).toMatch(/did not land in this run/);
		expect(emptyReason(unreadable("i3k9x0a2q"), "live")).toMatch(/fork can no longer be read/);
		expect(emptyReason(unreadable("i3k9x0a2q"), "past-run")).toMatch(/trunk of this run can no longer be read/);
		expect(emptyReason({ ...empty, head: null }, "recording")).toMatch(/pushed nothing when the recording ended/);
		expect(emptyReason(empty, "live")).toBe("What it pushed changed no files.");
		expect(emptyReason(empty, "past-run")).toMatch(/already on trunk/);
	});

	it("says which version of the work is on show", () => {
		expect(changesTail({}, "live")).toBe(".");
		expect(changesTail({ staged: true }, "live")).toMatch(/not pushed yet/);
		expect(changesTail({}, "recording")).toMatch(/when the recording ended/);
		expect(changesTail({}, "past-run")).toBe(". As it landed on trunk.");
		expect(changesTail({ together: 1 }, "past-run")).toBe(". As it landed on trunk.");
		// Workload Intents land several to a commit, and the commit is all there is to compare.
		expect(changesTail({ together: 2 }, "past-run")).toMatch(/with 1 other workload Intent: these are the changes of all of them/);
		expect(changesTail({ together: 5 }, "past-run")).toMatch(/with 4 other workload Intents/);
	});
});
