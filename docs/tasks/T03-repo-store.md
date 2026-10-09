# T03: RepoStore port (memory and Artifacts implementations)

## Goal
All repo access in the app goes through one interface, so that:
- Logic can be tested offline (`MemoryRepoStore`).
- The deployed app uses real Artifacts (`ArtifactsRepoStore`, which combines the binding with isomorphic-git).

## Read first
- `CLAUDE.md`: Artifacts facts
- `docs/DECISIONS.md`: T00 results, which say which clone and push mode works
- `spikes/src/index.ts` and `spikes/src/memory-fs.ts`: reuse the working code
- `docs/vendor/cloudflare/artifacts/api/workers-binding.mdx`

## Interface: `src/worker/ports/repo-store.ts`
```ts
import type { CommitSha } from "../../shared/types";

export type FileMap = Record<string, string>;            // repo-relative path -> UTF-8 content
export type FileChanges = Record<string, string | null>; // null = delete

export interface RepoStore {
  /** Create an empty repo, or no-op if it exists. */
  ensureRepo(name: string): Promise<void>;
  /** Fork `source` at its default branch into `target`. Returns the fork's head commit. */
  fork(source: string, target: string): Promise<{ head: CommitSha }>;
  /** Head commit of `main`. */
  head(repo: string): Promise<CommitSha>;
  /** Read one file at a ref (branch name or commit sha). null if missing. */
  readFile(repo: string, ref: string, path: string): Promise<string | null>;
  /** All file paths at ref (recursive). */
  listFiles(repo: string, ref: string): Promise<string[]>;
  /** Whole tree as a FileMap (only text files under 1 MB). Used by gate/symbols. */
  snapshot(repo: string, ref: string): Promise<FileMap>;
  /** Commit `changes` on top of `expectedHead` and push to main. Throws StaleHeadError if main moved. */
  commit(repo: string, expectedHead: CommitSha, changes: FileChanges, message: string, author?: { name: string; email: string }): Promise<CommitSha>;
  /** Files changed between two commits (paths only). */
  changedPaths(repo: string, from: CommitSha, to: CommitSha): Promise<string[]>;
  /** Delete repo (cleanup). */
  remove(repo: string): Promise<void>;
}

export class StaleHeadError extends Error { constructor(public actual: CommitSha) { super(`stale head; actual ${actual}`); } }
```

## `MemoryRepoStore`: `src/worker/ports/memory-repo-store.ts`
- In-memory map: `repo → { commits: Map<sha, { parent, files: FileMap }>, main: sha }`.
- Commit sha = SHA-1 hex of `parent + JSON.stringify(sortedFiles) + message`, computed with `crypto.subtle`.
- `fork` copies the commit map, which is fine for tests.
- Add an optional constructor seed: `new MemoryRepoStore({ trunk: files })`. It creates repo `"trunk"` with one commit.
- To make it usable in `wrangler dev` with `REPO_STORE=memory`: export a module-level singleton, `getMemoryStore()`. Note in DECISIONS.md that state resets on reload and is per-isolate. That is acceptable for local dev.

## `ArtifactsRepoStore`: `src/worker/ports/artifacts-repo-store.ts`
- Constructor: `(env: Env)`. Uses `env.ARTIFACTS`.
- Disposal: always use `using repo = await env.ARTIFACTS.get(name)`.
- **Reads:**
  - `readFile` uses the binding: `repo.readFile({ ref, path })` and then `.text()`.
  - `head` uses `log({ ref: "main", limit: 1 })[0].sha`. Check the actual field name in the type definitions.
  - `listFiles` and `snapshot` walk the tree with `readCommit`, then recursive `readTree`, then `readBlob`. Run at most 16 in parallel.
- **Writes** go through isomorphic-git with the MemoryFS from the spike:
  1. Mint a short write token: `createToken("write", 600)`.
  2. Clone with `{ singleBranch: true, depth: 1, ref: "main" }`, or a full clone if T00 found shallow push fails.
  3. Verify the head matches `expectedHead`. Throw `StaleHeadError` if not.
  4. Apply the changes, `add` or `remove` each file, commit and push.
  5. Return the new sha.
- **Remote URL:** use the `remote` from `create`, `fork` or `info()`. Never hand-build it.
- **Retries:** if push is rejected because main is not fast-forward, throw `StaleHeadError`.
- **`changedPaths`:** compare two trees recursively by blob sha.
- **Factory:** `src/worker/ports/index.ts` exports `getRepoStore(env)`. It returns the memory or Artifacts store depending on `env.REPO_STORE`.

## Tests
- `memory-repo-store.test.ts` (unit):
  - fork independence
  - commit, then readFile
  - StaleHeadError on a wrong `expectedHead`
  - changedPaths
  - snapshot
  - deletes
- A shared contract test, `repo-store.contract.ts`: a function `runContract(makeStore)` that both stores can use. Run it in unit tests against memory.
- `scripts/smoke.ts` (extend the T01 version):
  1. Call `POST /api/admin/smoke` on the deployed Worker, with the header `x-admin-token: $ADMIN_TOKEN`.
  2. That route runs `runContract(() => new ArtifactsRepoStore(env))` against the real Artifacts.
  3. It returns the results and cleans up its repos (`smoke-*` names).

## Acceptance
```
npm test                           # memory contract passes
npm run typecheck
npm run deploy && PREMISE_URL=https://premise.<sub>.workers.dev ADMIN_TOKEN=... npm run smoke   # all contract cases pass against real Artifacts
```

## Pitfalls
- Workers isolates have 128 MB of memory. Skip files larger than 1 MB in `snapshot`.
- `readBlob` returns an untyped Blob. Decode it with `TextDecoder`.
- Rate limit: 2,000 git requests per 10 seconds per repo. Do not parallelize more than 16 in the tree walk.
