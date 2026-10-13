// GET /api/intents/:id/diff: what an Intent changed, read from its fork. The diff itself is pure
// (../diff/); this file only decides which two versions of which files to compare.
import type { CommitSha, Intent, IntentId } from "../../shared/types";
import { buildIntentDiff, type IntentDiff, reviewPaths, unavailableDiff } from "../diff/intent-diff";
import { mapLimit } from "../ports/git-tree";
import type { FileChanges, RepoStore } from "../ports/repo-store";
import { Memo } from "./memo";

const READS_AT_ONCE = 8;
const DIFFS_KEPT = 24;

export type DiffIntent = Pick<Intent, "id" | "repo" | "baseCommit" | "headCommit" | "status">;

/** Diffs between two commits of a fork. Commits never change, so neither do these. */
const pushedDiffs = new Memo<IntentDiff>(Number.POSITIVE_INFINITY, DIFFS_KEPT);

/**
 * The commit in the Intent's own fork that holds its work, or null if it has pushed nothing.
 * Landing records the trunk commit as the Intent's head, and that commit is not in the fork: for
 * a landed Intent the work is whatever its fork's `main` points at, which is what the gate took.
 */
export async function forkHead(intent: DiffIntent, store: Pick<RepoStore, "head">): Promise<CommitSha | null> {
	if (intent.headCommit === null) {
		return null;
	}
	return intent.status === "landed" ? store.head(intent.repo) : intent.headCommit;
}

/** The fork at its base commit against the fork at `head`. */
export async function pushedDiff(intent: DiffIntent, head: CommitSha, store: Pick<RepoStore, "changedPaths" | "readFile">): Promise<IntentDiff> {
	const changed = reviewPaths(await store.changedPaths(intent.repo, intent.baseCommit, head));
	const changes = await mapLimit(changed.paths, READS_AT_ONCE, async (path) => {
		const [before, after] = await Promise.all([store.readFile(intent.repo, intent.baseCommit, path), store.readFile(intent.repo, head, path)]);
		return { path, before, after };
	});
	return buildIntentDiff({ intentId: intent.id, base: intent.baseCommit, head, changes, omitted: changed.total - changed.paths.length });
}

/**
 * What an Intent changed as it landed, read from the trunk of a run that has ended: the commit
 * that landed it against the commit before. Its fork is gone by then, and trunk has every landing.
 * A trunk that cannot be read (it was removed) gives an empty diff marked `unavailable`.
 */
export async function landedDiff(intentId: IntentId, trunk: string, landing: { commit: CommitSha; parent: CommitSha }, store: Pick<RepoStore, "changedPaths" | "readFile">, memo: Memo<IntentDiff> = pushedDiffs): Promise<IntentDiff> {
	try {
		const landed: DiffIntent = { id: intentId, repo: trunk, baseCommit: landing.parent, headCommit: landing.commit, status: "landed" };
		return await memo.get(`${trunk}@${landing.parent}..${landing.commit}`, () => pushedDiff(landed, landing.commit, store));
	} catch (error) {
		console.error(`could not read the landing of Intent ${intentId} in ${trunk}`, error);
		return unavailableDiff(intentId, landing.parent, landing.commit);
	}
}

/** The fork at its base commit against the edits the agent has made but not pushed. */
export async function stagedDiff(intent: DiffIntent, overlay: FileChanges, store: Pick<RepoStore, "readFile">): Promise<IntentDiff> {
	const staged = reviewPaths(Object.keys(overlay));
	const changes = await mapLimit(staged.paths, READS_AT_ONCE, async (path) => ({ path, before: await store.readFile(intent.repo, intent.baseCommit, path), after: overlay[path] ?? null }));
	return buildIntentDiff({ intentId: intent.id, base: intent.baseCommit, head: null, changes, omitted: staged.total - staged.paths.length });
}

/**
 * What the Intent changed: its pushed work if it has pushed, otherwise its staged edits. A fork
 * that cannot be read (a reset deleted it) gives an empty diff marked `unavailable`, not an error.
 */
export async function intentDiff(intent: DiffIntent, store: RepoStore, overlay: () => Promise<FileChanges>, memo: Memo<IntentDiff> = pushedDiffs): Promise<IntentDiff> {
	try {
		const head = await forkHead(intent, store);
		if (head === null) {
			return await stagedDiff(intent, await overlay(), store);
		}
		return await memo.get(`${intent.repo}@${intent.baseCommit}..${head}`, () => pushedDiff(intent, head, store));
	} catch (error) {
		console.error(`could not read the fork of Intent ${intent.id}`, error);
		return unavailableDiff(intent.id, intent.baseCommit, null);
	}
}
