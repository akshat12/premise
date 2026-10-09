# T15: The gate (Landing Durable Object)

**Recommended effort: High.**

## Goal
A single `Landing` Durable Object (`idFromName("trunk")`) lands queued intents on trunk, one batch at a time. For each intent:

1. **Textual rebase.** Do a three-way merge of the intent's changes onto the current trunk.
2. **Typecheck** the result (T07).
3. **Run** the intent's immutable acceptance tests, plus its asserted premises, in the isolate (T14).
4. If everything passes, **commit to trunk**.
5. Compute the **surface diff** between old and new trunk (T07).
6. Publish `trunk.advanced`.
7. Trigger **invalidation** (T16 provides `invalidate()`; leave a stub until then).

Never use the phrase "merge queue" anywhere in the UI or in copy. Call it "the gate".

## Read first
- `CLAUDE.md`
- `docs/SPEC.md`: "Mechanism", steps 5–7
- `src/worker/ports/repo-store.ts`
- `src/worker/surface/index.ts`
- `src/worker/runner/index.ts`
- `src/worker/intent/intent-do.ts`
- The `node-diff3` README in `node_modules`

## Files
- `src/worker/gate/rebase.ts` (pure)
- `src/worker/gate/landing.ts` (the Durable Object)
- `src/worker/gate/gate.ts` (pure orchestration that takes injected deps, so it can be tested)

## Pure rebase: `rebase.ts`

```ts
export interface RebaseResult { files: FileMap; conflicts: string[]; }   // files = trunk snapshot with intent changes applied
export function threeWayRebase(base: FileMap, intentHead: FileMap, trunk: FileMap): RebaseResult;
```

Apply these rules to every path that changed between `base` and `intentHead`, ignoring `.intent/`:

| Situation | Result |
|---|---|
| Unchanged on trunk since base | Take the intent's version |
| Changed on trunk | `diff3Merge(intentLines, baseLines, trunkLines)`. A conflict adds the path to `conflicts`. |
| Deleted by the intent, unchanged on trunk | Delete it |
| Deleted by the intent, changed on trunk | Conflict |

## Gate pipeline: `gate.ts`

```ts
export interface GateDeps {
  snapshot(repo: string, ref: string): Promise<FileMap>;
  head(repo: string): Promise<CommitSha>;
  commitTrunk(expectedHead: CommitSha, changes: FileChanges, message: string): Promise<CommitSha>;
  typecheck(files: FileMap): TypecheckResult;
  surface(files: FileMap): { map: SurfaceMap };
  run(req: RunRequest): Promise<RunResult>;
}
export async function gateOne(deps: GateDeps, intent: Intent, path: "rebase" | "rederive" | "baseline", opts?: { skipAssertions?: boolean; skipTests?: boolean }): Promise<{ report: GateReport; changedSymbols: SymbolId[]; newTrunkFiles?: FileMap }>;
```

Steps:
1. Take snapshots of the trunk head, the intent base, and the intent head.
2. Run `threeWayRebase`.
   - If there are conflicts, return `textConflict: true` and `ok: false`. Do not land.
3. Run `typecheck(merged)`.
   - If it fails, return `ok: false`.
4. Run `run({ files: merged, tests: intent.acceptance → {file, name}, assertions: intent.premises.filter(asserted).map(p => p.assertion) })`.
5. If every test and assertion passed:
   - Commit the diff between the trunk snapshot and the merged files to trunk, with message `intent <id>: <goal>`. Add the trailer `Premise-Intent: <id>`.
   - If `commitTrunk` throws `StaleHeadError`, run the whole thing again from step 1. Retry at most once.
6. Compute `diffSurface(surface(trunkBefore).map, surface(merged).map)`. Set `changedSymbols` to the changed and removed symbols.
7. Return the `GateReport`, including `durationMs`.

## Landing Durable Object: `landing.ts`

**State:** a FIFO table `queue(intent_id, path, enqueued_at)` and a `busy` flag.

**RPC methods:**
- `enqueue(intentId, path = "rebase")` adds a row and kicks off processing with `ctx.waitUntil`. Using an alarm set 0 ms ahead is also fine.
- `status()` returns `{ queue, busy }`.

**Processing:**
1. Take up to 5 intents per batch, in priority order. Lower `priority` (taken from task order) goes first. Process them **sequentially**.
2. For each intent:
   1. `act({a:"gate"})`
   2. `gateOne(...)`
   3. Publish `gate.result`.
3. Then handle the outcome:

| Outcome | What to do |
|---|---|
| `ok` | `act({a:"land", commit})`. Publish `trunk.advanced`. Call `invalidate(env, { commit, byIntent, changedSymbols, newTrunkFiles })`. Update metrics: `intentsLanded`, and recount the agents. |
| Text conflict on path `"rebase"` | Treat it as stale: `act({a:"stale"})`. T17 will re-derive it. |
| Typecheck or test failure | `act({a:"fail"})` for now. T17 changes this to stale-then-rederive. |

**Trunk write token:** only the gate ever holds one. `ArtifactsRepoStore.commit` mints a short-lived token per commit, which is fine.

## Tests

**Unit tests for `threeWayRebase`:**
- Clean apply
- Non-overlapping edits in the same file merge
- Overlapping edits conflict
- The delete cases

**Unit tests for `gateOne`, with fake deps backed by `MemoryRepoStore` plus the real typecheck and surface:**
- A clean intent lands, and `changedSymbols` is correct.
- An intent with a type error does not land.
- **The scenario:**
  1. t01 lands first. `changedSymbols` does NOT include `verifySession`, because its surface is unchanged.
  2. Then t02's textual rebase gives `textConflict: false` and typecheck ok, **but the acceptance test fails**, so `ok: false`.

  This exact result is what the video shows.

**Workers-pool test:**
- `enqueue` two intents and confirm they land in order, with events published.

## Acceptance
```
npm test -- gate
npm run typecheck
```
