import { describe, expect, it } from "vitest";
import { buildIntentDiff, capHunks, fileDiff, isReviewable, MAX_CHANGED_LINES, MAX_FILE_LENGTH, MAX_FILES, reviewPaths, unavailableDiff } from "./intent-diff";
import { diffText } from "./lines";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");
const changedIn = (file: { hunks: { lines: { kind: string }[] }[] } | null) => (file?.hunks ?? []).flatMap((hunk) => hunk.lines).filter((line) => line.kind !== " ").length;

describe("reviewPaths", () => {
	it("leaves out .intent/, sorts, and cuts to the limit", () => {
		expect(isReviewable(".intent/notes.md")).toBe(false);
		expect(isReviewable("src/.intent/x.ts")).toBe(true);
		expect(reviewPaths(["src/b.ts", ".intent/record.json", "src/a.ts", "src/b.ts"])).toEqual({ paths: ["src/a.ts", "src/b.ts"], total: 2 });
		const many = Array.from({ length: 55 }, (_, index) => `src/f${String(index).padStart(2, "0")}.ts`);
		const cut = reviewPaths(many);
		expect(cut.total).toBe(55);
		expect(cut.paths).toHaveLength(MAX_FILES);
		expect(cut.paths[0]).toBe("src/f00.ts");
	});
});

describe("fileDiff", () => {
	it("says whether the file was added, modified or deleted", () => {
		expect(fileDiff("a.ts", null, "one\n")).toMatchObject({ path: "a.ts", status: "added", hunks: [{ oldStart: 0, newStart: 1 }] });
		expect(fileDiff("a.ts", "one\n", null)).toMatchObject({ status: "deleted", hunks: [{ oldStart: 1, newStart: 0 }] });
		expect(fileDiff("a.ts", "one\n", "two\n")).toEqual({ path: "a.ts", status: "modified", hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "-", text: "one" }, { kind: "+", text: "two" }] }] });
	});

	it("is null when nothing changed", () => {
		expect(fileDiff("a.ts", "same\n", "same\n")).toBeNull();
		expect(fileDiff("a.ts", null, null)).toBeNull();
	});

	it("keeps an added empty file, which has no lines to show", () => {
		expect(fileDiff("empty.ts", null, "")).toEqual({ path: "empty.ts", status: "added", hunks: [] });
	});

	it("cuts a file at 400 changed lines and says so", () => {
		const big = fileDiff("big.ts", null, lines(MAX_CHANGED_LINES + 50));
		expect(big?.truncated).toBe(true);
		expect(changedIn(big)).toBe(MAX_CHANGED_LINES);
		const exact = fileDiff("exact.ts", null, lines(MAX_CHANGED_LINES));
		expect(exact?.truncated).toBeUndefined();
		expect(changedIn(exact)).toBe(MAX_CHANGED_LINES);
	});

	it("does not compare binary or very large files", () => {
		expect(fileDiff("logo.png", null, "\u0089PNG\u0000\u0001")).toEqual({ path: "logo.png", status: "added", hunks: [], binary: true });
		expect(fileDiff("huge.txt", "a\n", "x".repeat(MAX_FILE_LENGTH + 1))).toEqual({ path: "huge.txt", status: "modified", hunks: [], truncated: true });
	});
});

describe("capHunks", () => {
	it("counts changed lines across hunks, not context", () => {
		const before = lines(40);
		const after = before.replace("line 5\n", "line five\n").replace("line 30\n", "line thirty\n");
		const hunks = diffText(before, after);
		expect(hunks).toHaveLength(2);
		// Four changed lines in all (two per hunk).
		expect(capHunks(hunks, 4)).toEqual({ hunks, truncated: false });
		expect(capHunks(hunks, 2)).toEqual({ hunks: [hunks[0]], truncated: true });
		const cut = capHunks(hunks, 3);
		expect(cut.truncated).toBe(true);
		expect(cut.hunks[1]?.lines.at(-1)).toEqual({ kind: "-", text: "line 30" });
	});
});

describe("buildIntentDiff", () => {
	it("lists changed files by path, without .intent/ and without files that did not change", () => {
		const diff = buildIntentDiff({
			intentId: "i3k9x0a2q",
			base: BASE,
			head: HEAD,
			changes: [
				{ path: "src/b.ts", before: "one\n", after: "two\n" },
				{ path: ".intent/record.json", before: null, after: "{}" },
				{ path: "src/a.ts", before: null, after: "new\n" },
				{ path: "src/same.ts", before: "x\n", after: "x\n" },
			],
		});
		expect(diff).toMatchObject({ intentId: "i3k9x0a2q", base: BASE, head: HEAD, fileCount: 2 });
		expect(diff.files.map((file) => [file.path, file.status])).toEqual([
			["src/a.ts", "added"],
			["src/b.ts", "modified"],
		]);
		expect(diff.truncated).toBeUndefined();
		expect(diff.staged).toBeUndefined();
	});

	it("keeps at most 40 files and counts the rest", () => {
		const changes = Array.from({ length: MAX_FILES + 3 }, (_, index) => ({ path: `src/f${String(index).padStart(2, "0")}.ts`, before: null, after: "x\n" }));
		const diff = buildIntentDiff({ intentId: "i3k9x0a2q", base: BASE, head: HEAD, changes });
		expect(diff.files).toHaveLength(MAX_FILES);
		expect(diff).toMatchObject({ fileCount: MAX_FILES + 3, truncated: true });
		// The caller read only the first 40 of 52: the 12 it left out are counted too.
		const partial = buildIntentDiff({ intentId: "i3k9x0a2q", base: BASE, head: HEAD, changes: changes.slice(0, MAX_FILES), omitted: 12 });
		expect(partial).toMatchObject({ fileCount: MAX_FILES + 12, truncated: true });
	});

	it("marks unpushed edits as staged", () => {
		const staged = buildIntentDiff({ intentId: "i3k9x0a2q", base: BASE, head: null, changes: [{ path: "src/a.ts", before: "a\n", after: null }] });
		expect(staged).toMatchObject({ head: null, staged: true, files: [{ path: "src/a.ts", status: "deleted" }] });
		expect(buildIntentDiff({ intentId: "i3k9x0a2q", base: BASE, head: null, changes: [] })).toEqual({ intentId: "i3k9x0a2q", base: BASE, head: null, files: [], fileCount: 0 });
	});

	it("has a shape for a fork that cannot be read", () => {
		expect(unavailableDiff("i3k9x0a2q", BASE, HEAD)).toEqual({ intentId: "i3k9x0a2q", base: BASE, head: HEAD, files: [], fileCount: 0, unavailable: true });
	});
});
