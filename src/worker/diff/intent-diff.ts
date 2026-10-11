// What an Intent changed, as a unified diff a person can review. Pure: the caller supplies the
// file contents (see routes/diff.ts for where they come from).
import type { CommitSha, IntentId } from "../../shared/types";
import { diffLines, type Hunk, hunksOf, splitLines } from "./lines";

export type FileStatus = "added" | "modified" | "deleted";

export interface FileDiff {
	path: string;
	status: FileStatus;
	hunks: Hunk[];
	/** Not all of this file's changes are here: it has more than MAX_CHANGED_LINES of them, or it is too big to compare. */
	truncated?: true;
	/** Not text, so there are no lines to show. */
	binary?: true;
}

/** The response of GET /api/intents/:id/diff. `src/ui/lib/diff.ts` has the same shape for the browser. */
export interface IntentDiff {
	intentId: IntentId;
	/** The trunk commit the Intent's fork started from. */
	base: CommitSha;
	/** The commit in the fork that `files` is compared at. null when nothing is pushed yet. */
	head: CommitSha | null;
	files: FileDiff[];
	/** How many files changed, including any left out of `files`. */
	fileCount: number;
	/** More than MAX_FILES files changed; `files` has the first MAX_FILES by path. */
	truncated?: true;
	/** `files` is what the agent has edited but not pushed (`head` is null). */
	staged?: true;
	/** The Intent's fork could not be read (it was deleted by a reset, for example), so `files` is empty. */
	unavailable?: true;
}

export const MAX_FILES = 40;
export const MAX_CHANGED_LINES = 400;
/** A side longer than this is not compared at all. In UTF-16 units, which is what a string's length counts. */
export const MAX_FILE_LENGTH = 512 * 1024;

/** `.intent/` holds the Intent's own record of itself, not work to review. */
export function isReviewable(path: string): boolean {
	return !path.startsWith(".intent/");
}

/** The paths a diff covers: reviewable ones, sorted, at most `max`. `total` counts them before the cut. */
export function reviewPaths(paths: readonly string[], max: number = MAX_FILES): { paths: string[]; total: number } {
	const reviewable = [...new Set(paths)].filter(isReviewable).sort();
	return { paths: reviewable.slice(0, max), total: reviewable.length };
}

/** Cuts hunks off after `max` changed lines (context lines are not counted). */
export function capHunks(hunks: readonly Hunk[], max: number = MAX_CHANGED_LINES): { hunks: Hunk[]; truncated: boolean } {
	const kept: Hunk[] = [];
	let changed = 0;
	for (const hunk of hunks) {
		if (changed >= max) {
			return { hunks: kept, truncated: true };
		}
		let end = 0;
		while (end < hunk.lines.length && changed < max) {
			changed += hunk.lines[end]?.kind === " " ? 0 : 1;
			end++;
		}
		if (end < hunk.lines.length) {
			// Whatever is left of this hunk is dropped too, unless it is only the context after the last change.
			const restChanges = hunk.lines.slice(end).some((line) => line.kind !== " ");
			if (restChanges) {
				kept.push({ ...hunk, lines: hunk.lines.slice(0, end) });
				return { hunks: kept, truncated: true };
			}
		}
		kept.push({ ...hunk, lines: [...hunk.lines] });
	}
	return { hunks: kept, truncated: false };
}

const isBinary = (content: string | null) => content !== null && content.includes("\u0000");

/**
 * One file's diff from its content before and after (null = the file is not there).
 * Returns null when there is nothing to show: the content is the same, or the file is on neither side.
 */
export function fileDiff(path: string, before: string | null, after: string | null, maxChanged: number = MAX_CHANGED_LINES): FileDiff | null {
	if (before === after) {
		return null;
	}
	const status: FileStatus = before === null ? "added" : after === null ? "deleted" : "modified";
	if (isBinary(before) || isBinary(after)) {
		return { path, status, hunks: [], binary: true };
	}
	if ((before?.length ?? 0) > MAX_FILE_LENGTH || (after?.length ?? 0) > MAX_FILE_LENGTH) {
		return { path, status, hunks: [], truncated: true };
	}
	const capped = capHunks(hunksOf(diffLines(splitLines(before ?? ""), splitLines(after ?? ""))), maxChanged);
	return { path, status, hunks: capped.hunks, ...(capped.truncated ? { truncated: true as const } : {}) };
}

export interface DiffInput {
	intentId: IntentId;
	base: CommitSha;
	head: CommitSha | null;
	/** Each changed path with its content on both sides. Paths under `.intent/` and unchanged files are left out. */
	changes: readonly { path: string; before: string | null; after: string | null }[];
	/** How many more changed files there are that the caller did not read (see `reviewPaths`). */
	omitted?: number;
}

/** Puts the response together. With `head` null, the changes are the agent's unpushed edits. */
export function buildIntentDiff({ intentId, base, head, changes, omitted = 0 }: DiffInput): IntentDiff {
	const all = [...changes]
		.filter((change) => isReviewable(change.path))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.flatMap((change) => fileDiff(change.path, change.before, change.after) ?? []);
	const files = all.slice(0, MAX_FILES);
	const fileCount = all.length + omitted;
	return {
		intentId,
		base,
		head,
		files,
		fileCount,
		...(fileCount > files.length ? { truncated: true as const } : {}),
		...(head === null && files.length > 0 ? { staged: true as const } : {}),
	};
}

/** What is answered when the Intent's fork cannot be read. */
export function unavailableDiff(intentId: IntentId, base: CommitSha, head: CommitSha | null): IntentDiff {
	return { intentId, base, head, files: [], fileCount: 0, unavailable: true };
}
