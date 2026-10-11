import { describe, expect, it } from "vitest";
import { type DiffLine, diffLines, diffText, type Hunk, hunksOf, MAX_EDITS, splitLines } from "./lines";

const show = (script: readonly DiffLine[]) => script.map((line) => `${line.kind}${line.text}`);
const oldSide = (script: readonly DiffLine[]) => script.filter((line) => line.kind !== "+").map((line) => line.text);
const newSide = (script: readonly DiffLine[]) => script.filter((line) => line.kind !== "-").map((line) => line.text);
const changed = (script: readonly DiffLine[]) => script.filter((line) => line.kind !== " ").length;
const letters = (text: string) => text.split("");

/** Rebuilds the new file from the old one and the hunks, checking each hunk sits where it says it does. */
function apply(before: string[], hunks: readonly Hunk[]): string[] {
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const hasOld = hunk.lines.some((line) => line.kind !== "+");
		const from = hasOld ? hunk.oldStart - 1 : hunk.oldStart;
		out.push(...before.slice(cursor, from));
		const hasNew = hunk.lines.some((line) => line.kind !== "-");
		expect(hunk.newStart).toBe(out.length + (hasNew ? 1 : 0));
		expect(oldSide(hunk.lines)).toEqual(before.slice(from, from + oldSide(hunk.lines).length));
		out.push(...newSide(hunk.lines));
		cursor = from + oldSide(hunk.lines).length;
	}
	return [...out, ...before.slice(cursor)];
}

describe("splitLines", () => {
	it("does not count a final newline as a line", () => {
		expect(splitLines("")).toEqual([]);
		expect(splitLines("a")).toEqual(["a"]);
		expect(splitLines("a\n")).toEqual(["a"]);
		expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
		expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
	});
});

describe("diffLines", () => {
	it("marks nothing when the files are the same", () => {
		expect(show(diffLines(["a", "b"], ["a", "b"]))).toEqual([" a", " b"]);
		expect(diffLines([], [])).toEqual([]);
	});

	it("handles an empty side", () => {
		expect(show(diffLines([], ["a", "b"]))).toEqual(["+a", "+b"]);
		expect(show(diffLines(["a", "b"], []))).toEqual(["-a", "-b"]);
	});

	it("finds an insertion, a deletion and a replacement", () => {
		expect(show(diffLines(["a", "c"], ["a", "b", "c"]))).toEqual([" a", "+b", " c"]);
		expect(show(diffLines(["a", "b", "c"], ["a", "c"]))).toEqual([" a", "-b", " c"]);
		expect(show(diffLines(["a", "b", "c"], ["a", "x", "c"]))).toEqual([" a", "-b", "+x", " c"]);
	});

	it("finds the shortest script, and puts removed lines before added ones", () => {
		// The example from Myers' paper: 5 edits, and no shorter script exists.
		const script = diffLines(letters("abcabba"), letters("cbabac"));
		expect(changed(script)).toBe(5);
		expect(oldSide(script).join("")).toBe("abcabba");
		expect(newSide(script).join("")).toBe("cbabac");
		for (let index = 1; index < script.length; index++) {
			expect(`${script[index - 1]?.kind}${script[index]?.kind}`).not.toBe("+-");
		}
	});

	it("always reproduces both files", () => {
		// A fixed pseudo-random sequence, so a failure can be reproduced.
		let seed = 42;
		const random = (below: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % below;
		};
		for (let round = 0; round < 200; round++) {
			const a = Array.from({ length: random(14) }, () => "abcd".charAt(random(4)));
			const b = Array.from({ length: random(14) }, () => "abcd".charAt(random(4)));
			const script = diffLines(a, b);
			expect(oldSide(script)).toEqual(a);
			expect(newSide(script)).toEqual(b);
			expect(apply(a, hunksOf(script, random(4)))).toEqual(b);
		}
	});

	it("gives up the search on files with nothing in common, and still returns a correct diff", () => {
		const a = Array.from({ length: MAX_EDITS }, (_, index) => `old ${index}`);
		const b = Array.from({ length: MAX_EDITS }, (_, index) => `new ${index}`);
		const script = diffLines(["same", ...a, "end"], ["same", ...b, "end"]);
		expect(script).toHaveLength(2 * MAX_EDITS + 2);
		expect(show(script.slice(0, 2))).toEqual([" same", "-old 0"]);
		expect(show(script.slice(-2))).toEqual([`+new ${MAX_EDITS - 1}`, " end"]);
	});
});

describe("hunksOf", () => {
	const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

	it("returns nothing for files with the same lines", () => {
		expect(diffText("a\nb\n", "a\nb")).toEqual([]);
	});

	it("keeps three lines of context around a change", () => {
		const before = numbered(20);
		const after = before.map((line) => (line === "line 10" ? "line ten" : line));
		expect(hunksOf(diffLines(before, after))).toEqual([
			{
				oldStart: 7,
				newStart: 7,
				lines: [
					{ kind: " ", text: "line 7" },
					{ kind: " ", text: "line 8" },
					{ kind: " ", text: "line 9" },
					{ kind: "-", text: "line 10" },
					{ kind: "+", text: "line ten" },
					{ kind: " ", text: "line 11" },
					{ kind: " ", text: "line 12" },
					{ kind: " ", text: "line 13" },
				],
			},
		]);
	});

	it("joins changes whose context touches, and separates ones further apart", () => {
		const before = numbered(30);
		const change = (...lines: number[]) => before.map((line, index) => (lines.includes(index + 1) ? `${line}!` : line));
		// Lines 5 and 11: their context (6-8 and 8-10) meets, so one hunk.
		expect(hunksOf(diffLines(before, change(5, 11)))).toHaveLength(1);
		// Lines 5 and 13: line 9 is in neither's context, so two hunks.
		const apart = hunksOf(diffLines(before, change(5, 13)));
		expect(apart.map((hunk) => [hunk.oldStart, hunk.newStart, hunk.lines.length])).toEqual([
			[2, 2, 8],
			[10, 10, 8],
		]);
	});

	it("numbers a new file from 0 on the old side, and a deleted file from 0 on the new side", () => {
		expect(diffText("", "a\nb\n")).toEqual([{ oldStart: 0, newStart: 1, lines: [{ kind: "+", text: "a" }, { kind: "+", text: "b" }] }]);
		expect(diffText("a\nb\n", "")).toEqual([{ oldStart: 1, newStart: 0, lines: [{ kind: "-", text: "a" }, { kind: "-", text: "b" }] }]);
	});

	it("numbers a hunk after an earlier insertion by where it is in each file", () => {
		const before = numbered(20);
		const after = ["new first", ...before.slice(0, 14), "line 15 changed", ...before.slice(15)];
		const hunks = hunksOf(diffLines(before, after));
		expect(hunks.map((hunk) => [hunk.oldStart, hunk.newStart])).toEqual([
			[1, 1],
			[12, 13],
		]);
		expect(apply(before, hunks)).toEqual(after);
	});

	it("takes the amount of context as an argument", () => {
		expect(diffText("a\nb\nc\n", "a\nx\nc\n", 0)).toEqual([{ oldStart: 2, newStart: 2, lines: [{ kind: "-", text: "b" }, { kind: "+", text: "x" }] }]);
	});
});
