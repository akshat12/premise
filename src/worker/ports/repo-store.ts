import type { CommitSha } from "../../shared/types";

export type FileMap = Record<string, string>;            // repo-relative path -> UTF-8 content
export type FileChanges = Record<string, string | null>; // null = delete

export interface RepoStore {
  /** Create an empty repo, or no-op if it exists. */
  ensureRepo(name: string): Promise<void>;
  /** Fork `source` at its default branch into `target`. Returns the fork's head commit. */
  fork(source: string, target: string): Promise<{ head: CommitSha }>;
  /** Head commit of `main`. `ZERO_SHA` while the repo has no commits. */
  head(repo: string): Promise<CommitSha>;
  /** Read one file at a ref (branch name or commit sha). null if missing. */
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  /** All file paths at ref (recursive), sorted. */
  listFiles(repo: string, ref: string): Promise<string[]>;
  /** Whole tree as a FileMap (only text files under 1 MB). Used by gate/symbols. */
  snapshot(repo: string, ref: string): Promise<FileMap>;
  /** Commit `changes` on top of `expectedHead` and push to main. Throws StaleHeadError if main moved. */
  commit(repo: string, expectedHead: CommitSha, changes: FileChanges, message: string, author?: { name: string; email: string }): Promise<CommitSha>;
  /** Files changed between two commits (paths only), sorted. `from` may be `ZERO_SHA`. */
  changedPaths(repo: string, from: CommitSha, to: CommitSha): Promise<string[]>;
  /** Delete repo (cleanup). */
  remove(repo: string): Promise<void>;
}

export class StaleHeadError extends Error { constructor(public actual: CommitSha) { super(`stale head; actual ${actual}`); } }

/** Head of a repo with no commits yet. Pass it as `expectedHead` to create the first commit. */
export const ZERO_SHA: CommitSha = "0".repeat(40);

/** `snapshot` skips files larger than this, to stay inside a Worker isolate's 128 MB. */
export const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

export const DEFAULT_AUTHOR = { name: "Premise", email: "premise@example.com" };

export function isCommitSha(ref: string): boolean {
	return /^[0-9a-f]{40}$/.test(ref);
}
