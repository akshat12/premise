# T16: Premise invalidation (and the trunk `pushed` event consumer)

## Goal
When trunk advances, find every in-flight intent whose premises no longer hold. Mark each one `broken` with a targeted reason, so the intent goes `stale`. A premise breaks in two ways:

| Premise source | When it breaks | Reason text |
|---|---|---|
| observed or derived | Its `SymbolId` is in `changedSymbols` (a type-surface change) | `"type surface of <name> changed in intent <by>"` |
| asserted | Its assertion **fails** when re-run against the new trunk files | `"assertion '<description>' no longer holds after intent <by>"` |

The second case is the behavioural break that types can't see. It is the heart of the demo.

## Read first
- `CLAUDE.md`
- `src/worker/gate/gate.ts`
- `src/worker/ledger/client.ts` (`readersAcrossShards`)
- `src/worker/runner/index.ts`
- `src/worker/intent/intent-do.ts`
- The Artifacts event cheat-sheet in `docs/PLAN.md`

## Files
- `src/worker/gate/invalidate.ts`
- `src/worker/events/consumer.ts`

## `invalidate(env, { commit, byIntent, changedSymbols, newTrunkFiles })`
1. **Surface breaks.**
   - Call `readersAcrossShards(env, changedSymbols)`.
   - For each reader that isn't `byIntent` and isn't landed, failed or already stale, call `breakPremise(symbol, …)`.
2. **Assertion breaks.**
   1. List the in-flight intents from the registry. In-flight means status is one of: `planning`, `claiming`, `waiting`, `working`, `submitted`, `checking`, `queued`.
   2. Collect their holding asserted premises.
   3. Run them **all in one isolate call** with `runInIsolate({ files: newTrunkFiles, tests: [], assertions })`. Assertion ids must be unique per intent, so prefix them with `<intentId>:`.
   4. For each failure, call `breakPremise`.
3. **Idempotency.**
   - Keep a `processed_commits` table in the EventHub. Skip commits already in it.
   - The same commit can arrive twice: once from the gate, once from the Artifacts `pushed` event.
4. **Metrics.**
   - Publish `metrics`, with `premisesBroken` incremented.

## Queue consumer: `consumer.ts`
Wire this into `index.ts`'s `queue()` handler. For each message, `ack()` it in all cases.

| Event type | Action |
|---|---|
| `cf.artifacts.repo.pushed` where `source.repoName === currentTrunk` | If `payload.after` is not in `processed_commits`, someone pushed to trunk outside the gate (e.g. a human). Load snapshots of `before` and `after`, compute `diffSurface`, then call `invalidate` with `byIntent: null`. Always publish an `artifacts` event of type `pushed`. |
| `cf.artifacts.repo.forked` | Increment `forksCreated`. Publish an `artifacts` event of type `forked`, with the repo name. |
| `repo.created` | Publish an `artifacts` event (UI counter). |
| `repo.imported` | Publish an `artifacts` event (UI counter). |
| `repo.deleted` | Publish an `artifacts` event (UI counter). |

## Tests

**Unit tests** (invalidation logic with a fake ledger and runner):
- A surface change breaks only the readers of the changed symbols.
- An assertion failure breaks only that intent.
- A landed intent is never broken.
- Processing the same commit twice is a no-op.

**Scenario test** (memory store plus real runner, via the workers pool):
1. Dispatch t02, t03 and t04 (scripted, frozen in `working` with their premises recorded).
2. Land t01.
3. Expect t02 and t03 to go `stale` with assertion reasons.
4. Expect **t04 to stay `working`**. That is the no-over-triggering proof.

**Consumer test:**
- Feed it the example `pushed` and `forked` JSON from the cheat-sheet and check the events it publishes.

## Acceptance
```
npm test -- invalidat
npm test -- consumer
npm run typecheck
```
