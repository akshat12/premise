// What an Intent changed, as the Worker sends it (GET /api/intents/:id/diff) and as a recording
// carries it. The types repeat src/worker/diff/intent-diff.ts: the browser's TypeScript project
// cannot import Worker files. Everything here is pure.
import type { CommitSha, IntentId, IntentStatus } from "../../shared/types";

export type LineKind = " " | "+" | "-";

export interface DiffLine {
	kind: LineKind;
	text: string;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface FileDiff {
	path: string;
	status: "added" | "modified" | "deleted";
	hunks: DiffHunk[];
	/** Not all of the file's changes are here. */
	truncated?: true;
	/** Not text. */
	binary?: true;
}

export interface IntentDiff {
	intentId: IntentId;
	base: CommitSha;
	/** null when nothing is pushed yet. */
	head: CommitSha | null;
	files: FileDiff[];
	/** How many files changed, including any that `files` leaves out. */
	fileCount?: number;
	truncated?: true;
	/** `files` is what the agent has edited but not pushed. */
	staged?: true;
	/** The Intent's fork could not be read. */
	unavailable?: true;
}

/** What the Drawer is given: a diff, null for "there is none", or "loading" while it is being fetched. */
export type DiffState = IntentDiff | null | "loading";

const isLine = (value: unknown): value is DiffLine => typeof value === "object" && value !== null && typeof (value as DiffLine).text === "string" && [" ", "+", "-"].includes((value as DiffLine).kind);
const isHunk = (value: unknown): value is DiffHunk => typeof value === "object" && value !== null && Number.isInteger((value as DiffHunk).oldStart) && Number.isInteger((value as DiffHunk).newStart) && Array.isArray((value as DiffHunk).lines) && (value as DiffHunk).lines.every(isLine);
const isFile = (value: unknown): value is FileDiff => typeof value === "object" && value !== null && typeof (value as FileDiff).path === "string" && ["added", "modified", "deleted"].includes((value as FileDiff).status) && Array.isArray((value as FileDiff).hunks) && (value as FileDiff).hunks.every(isHunk);

/** True for something with the shape of an IntentDiff. What comes off the network or out of a file is checked before it is drawn. */
export function isIntentDiff(value: unknown): value is IntentDiff {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const diff = value as IntentDiff;
	return typeof diff.intentId === "string" && typeof diff.base === "string" && (diff.head === null || typeof diff.head === "string") && Array.isArray(diff.files) && diff.files.every(isFile);
}

/** A diff that says only "the fork could not be read". */
export function unreadable(intentId: IntentId): IntentDiff {
	return { intentId, base: "", head: null, files: [], unavailable: true };
}

/** How many lines a file's diff adds and removes. */
export function countChanges(file: FileDiff): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of file.hunks) {
		for (const line of hunk.lines) {
			added += line.kind === "+" ? 1 : 0;
			removed += line.kind === "-" ? 1 : 0;
		}
	}
	return { added, removed };
}

/** The same, over every file in the diff. `files` counts files that are not shown too. */
export function totals(diff: IntentDiff): { files: number; added: number; removed: number } {
	const counts = diff.files.map(countChanges);
	return { files: Math.max(diff.fileCount ?? 0, diff.files.length), added: counts.reduce((sum, count) => sum + count.added, 0), removed: counts.reduce((sum, count) => sum + count.removed, 0) };
}

/** A hunk's header as a unified diff writes it: "@@ -12,7 +12,9 @@". */
export function hunkHeader(hunk: DiffHunk): string {
	const oldCount = hunk.lines.filter((line) => line.kind !== "+").length;
	const newCount = hunk.lines.filter((line) => line.kind !== "-").length;
	return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`;
}

export interface NumberedLine extends DiffLine {
	/** The line's number in the file it is shown from: the old file for a removed line, the new file for the rest. */
	no: number;
}

/** A hunk's lines with their line numbers. */
export function numberLines(hunk: DiffHunk): NumberedLine[] {
	// With no lines on a side, that side's start is the line before the hunk (see hunksOf in the Worker).
	let oldNo = hunk.lines.some((line) => line.kind !== "+") ? hunk.oldStart : hunk.oldStart + 1;
	let newNo = hunk.lines.some((line) => line.kind !== "-") ? hunk.newStart : hunk.newStart + 1;
	return hunk.lines.map((line) => {
		if (line.kind === "-") {
			return { ...line, no: oldNo++ };
		}
		if (line.kind === " ") {
			oldNo++;
		}
		return { ...line, no: newNo++ };
	});
}

/**
 * Which stretch of its life an Intent is in, as far as its diff goes. The diff is fetched again
 * when this changes and not otherwise: when it pushes, when it is queued for the gate, when it
 * lands, when it goes stale, and when a re-derive starts it again on a new fork.
 */
export function diffPhase(status: IntentStatus): "editing" | "pushed" | "queued" | "landed" | "stale" | "rederiving" | "stopped" {
	switch (status) {
		case "planning":
		case "claiming":
		case "waiting":
		case "working":
			return "editing";
		case "submitted":
		case "checking":
		case "quarantined":
			return "pushed";
		case "queued":
		case "gating":
			return "queued";
		case "landed":
			return "landed";
		case "stale":
			return "stale";
		case "rederiving":
			return "rederiving";
		case "escalated":
		case "failed":
			return "stopped";
	}
}
