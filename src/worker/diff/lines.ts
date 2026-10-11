// A plain line diff (Myers), and the hunks a unified diff shows. Pure: no Cloudflare, no repo.

export type LineKind = " " | "+" | "-";

export interface DiffLine {
	kind: LineKind;
	text: string;
}

export interface Hunk {
	/** 1-based line where the hunk starts in the old file. With no old lines in the hunk, the line before it (0 at the top), as git does. */
	oldStart: number;
	/** The same, for the new file. */
	newStart: number;
	lines: DiffLine[];
}

export const CONTEXT_LINES = 3;

/**
 * Past this many edits the search stops and the files are shown as "all of the old, then all of
 * the new". It bounds memory (the search keeps about `MAX_EDITS²` integers) and loses nothing a
 * reader would see, because a file's diff is cut long before this many changed lines.
 */
export const MAX_EDITS = 1000;

/** A file's lines. A final newline does not make an empty last line; "" has no lines. */
export function splitLines(text: string): string[] {
	if (text === "") {
		return [];
	}
	const lines = text.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}

const keep = (text: string): DiffLine => ({ kind: " ", text });
const added = (text: string): DiffLine => ({ kind: "+", text });
const removed = (text: string): DiffLine => ({ kind: "-", text });

/** The shortest edit script from `a` to `b`, in order from the end to the start, or null past MAX_EDITS. */
function shortestEdit(a: readonly string[], b: readonly string[]): DiffLine[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, MAX_EDITS);
	const offset = max + 1;
	// furthest[offset + k] is the furthest x reached on diagonal k (k = x - y).
	const furthest = new Int32Array(2 * max + 3);
	const at = (row: Int32Array, index: number) => row[index] ?? 0;
	// before[d] is `furthest` as round d found it, for diagonals -d-1 .. d+1.
	const before: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		before.push(furthest.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			const down = k === -d || (k !== d && at(furthest, offset + k - 1) < at(furthest, offset + k + 1));
			let x = down ? at(furthest, offset + k + 1) : at(furthest, offset + k - 1) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			furthest[offset + k] = x;
			if (x >= n && y >= m) {
				return walkBack(a, b, before, d);
			}
		}
	}
	return null;
}

function walkBack(a: readonly string[], b: readonly string[], before: readonly Int32Array[], edits: number): DiffLine[] {
	const script: DiffLine[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = edits; d > 0; d--) {
		const row = before[d] as Int32Array;
		const at = (k: number) => row[k + d + 1] ?? 0;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const previousK = down ? k + 1 : k - 1;
		const previousX = at(previousK);
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			script.push(keep(a[x - 1] as string));
			x--;
			y--;
		}
		if (down) {
			script.push(added(b[y - 1] as string));
		} else {
			script.push(removed(a[x - 1] as string));
		}
		x = previousX;
		y = previousY;
	}
	while (x > 0 && y > 0) {
		script.push(keep(a[x - 1] as string));
		x--;
		y--;
	}
	return script;
}

/** Within each run of changed lines, the removed lines first and then the added ones, as a reader expects. */
function removedFirst(script: readonly DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let plus: DiffLine[] = [];
	for (const line of script) {
		if (line.kind === "+") {
			plus.push(line);
		} else if (line.kind === "-") {
			out.push(line);
		} else {
			out.push(...plus, line);
			plus = [];
		}
	}
	return [...out, ...plus];
}

/** Every line of both files, in order, each marked kept (" "), added ("+") or removed ("-"). */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const oldMiddle = a.slice(start, endA);
	const newMiddle = b.slice(start, endB);
	const found = oldMiddle.length === 0 || newMiddle.length === 0 ? null : shortestEdit(oldMiddle, newMiddle)?.reverse();
	const middle = found ?? [...oldMiddle.map(removed), ...newMiddle.map(added)];
	return [...a.slice(0, start).map(keep), ...removedFirst(middle), ...a.slice(endA).map(keep)];
}

/** Groups a script's changes into hunks, each with up to `context` unchanged lines around it. Changes closer than that share a hunk. */
export function hunksOf(script: readonly DiffLine[], context: number = CONTEXT_LINES): Hunk[] {
	// How many old and new lines come before each position.
	const oldBefore: number[] = [];
	const newBefore: number[] = [];
	let oldCount = 0;
	let newCount = 0;
	const ranges: { from: number; to: number }[] = [];
	script.forEach((line, index) => {
		oldBefore.push(oldCount);
		newBefore.push(newCount);
		oldCount += line.kind === "+" ? 0 : 1;
		newCount += line.kind === "-" ? 0 : 1;
		if (line.kind === " ") {
			return;
		}
		const from = Math.max(0, index - context);
		const to = Math.min(script.length, index + context + 1);
		const last = ranges.at(-1);
		if (last !== undefined && from <= last.to) {
			last.to = to;
		} else {
			ranges.push({ from, to });
		}
	});
	return ranges.map(({ from, to }) => {
		const lines = script.slice(from, to);
		const hasOld = lines.some((line) => line.kind !== "+");
		const hasNew = lines.some((line) => line.kind !== "-");
		return { oldStart: (oldBefore[from] ?? 0) + (hasOld ? 1 : 0), newStart: (newBefore[from] ?? 0) + (hasNew ? 1 : 0), lines };
	});
}

/** The hunks between two versions of a text file. Empty when their lines are the same. */
export function diffText(before: string, after: string, context: number = CONTEXT_LINES): Hunk[] {
	return hunksOf(diffLines(splitLines(before), splitLines(after)), context);
}
