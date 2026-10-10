// The textual rebase: apply what an Intent changed since its base onto the current trunk, with a
// three-way merge per file. Pure. This is the plain rebase the re-derive races against, and it is
// deliberately no smarter than git: it knows about lines, not about meaning.
import { diff3Merge } from "node-diff3";
import type { FileMap } from "../ports/repo-store";

export interface RebaseResult {
	/** The trunk snapshot with the Intent's changes applied. A conflicted path keeps trunk's version. */
	files: FileMap;
	/** Paths that could not be merged, sorted. */
	conflicts: string[];
}

/** The Intent's own bookkeeping. It never reaches trunk. */
const INTENT_DIR = ".intent/";

/** Line-based three-way merge of one file. `null` when the two sides changed the same lines differently. */
export function mergeText(intent: string, base: string, trunk: string): string | null {
	const regions = diff3Merge(intent.split("\n"), base.split("\n"), trunk.split("\n"), { excludeFalseConflicts: true });
	const lines: string[] = [];
	for (const region of regions) {
		if (region.ok === undefined) {
			return null;
		}
		lines.push(...region.ok);
	}
	return lines.join("\n");
}

/**
 * Rebases an Intent onto trunk. `base` is the trunk the Intent started from, `intentHead` is the
 * Intent's fork now, and `trunk` is trunk now. Paths the Intent did not change keep trunk's content.
 */
export function threeWayRebase(base: FileMap, intentHead: FileMap, trunk: FileMap): RebaseResult {
	const files: FileMap = { ...trunk };
	const conflicts: string[] = [];
	const paths = new Set([...Object.keys(base), ...Object.keys(intentHead)]);

	for (const path of [...paths].sort()) {
		const was = base[path];
		const mine = intentHead[path];
		const theirs = trunk[path];
		if (path.startsWith(INTENT_DIR) || was === mine) {
			continue; // not something the Intent changed
		}
		if (theirs === mine) {
			continue; // trunk already has exactly this change
		}
		if (theirs === was) {
			// Unchanged on trunk since the base: the Intent's version wins, whether an edit, a new file or a delete.
			if (mine === undefined) {
				delete files[path];
			} else {
				files[path] = mine;
			}
			continue;
		}
		// Both sides changed it. Only an edit against an edit can be merged line by line.
		const merged = was === undefined || mine === undefined || theirs === undefined ? null : mergeText(mine, was, theirs);
		if (merged === null) {
			conflicts.push(path);
		} else {
			files[path] = merged;
		}
	}
	return { files, conflicts };
}
