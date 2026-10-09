# T18: Scripted workload agents (300+)

## Goal
Show scale honestly. Run hundreds of **clearly labelled scripted agents** (`kind: "workload"`). They do **real** Artifacts operations through the same pipeline as LLM agents: intent, fork, claims, premises, push, checker, gate. The only difference is that a generator produces their edits instead of an LLM. This costs almost nothing.

## Read first
- `CLAUDE.md`
- `src/worker/symbols/index.ts`
- `src/worker/ledger/client.ts`
- `src/worker/gate/*`
- `src/worker/routes/dispatch*`
- Artifacts limits in `CLAUDE.md`: 2,000 control-plane requests per 10 s per namespace, 2,000 git requests per 10 s per repo

## Files
- `src/worker/workload/generate.ts` (pure)
- `src/worker/workload/run.ts`
- Route `POST /api/admin/workload`

## Edit generator (pure, seeded RNG with mulberry32)

```ts
export interface WorkloadEdit { reads: SymbolId[]; claims: Claim[]; changes: (files: FileMap) => FileChanges; label: string; }
export function generateEdits(index: Map<SymbolId, SymbolInfo>, files: FileMap, n: number, seed: number, overlapRate: number): WorkloadEdit[];
```

Edit kinds and their weights:

| Kind | Weight | What it does |
|---|---|---|
| (a) | 50% | Adds a new exported helper in a new file `src/generated/w<i>.ts` that imports and calls 1–2 existing symbols. Reads those symbols; claims only the new symbol. |
| (b) | 30% | Edits the **body** of an existing function in a behaviour-preserving way: adds a guard comment and a no-op `const _w<i> = 0;` line inside the body. Claims body. |
| (c) | 15% | Adds an optional field to an existing interface. Claims interface. This changes the surface and triggers invalidation of readers. |
| (d) | 5% | Edits the same function as another edit, controlled by `overlapRate`. This triggers ledger contention. |

Every generated edit must typecheck on the base. Assert this in a test by applying 50 random edits one at a time.

## Runner

`runWorkload(env, { n, seed, concurrency = 25, overlapRate = 0.1 })`:
- **Token bucket** limits Artifacts calls to about 150 per second total. That is well under 2,000 per 10 s, leaving room for the real agents.
- For each edit:
  1. `newIntentId()`, then fork trunk.
  2. IntentDO `init` with `kind: "workload"`.
  3. Record the premises as observed, with surface hashes from a single cached `surface(trunk)`.
  4. Request claims. On wait, depend or split, retry with backoff up to 3 times, then fail. Workload agents don't escalate to humans.
  5. Commit to the fork.
  6. `runChecker`, then the gate as usual.
- Use `publishMany` and batch metrics every 2 seconds, so 300 agents don't flood the WebSocket.
- **Gate throughput.** Workload intents have no tests or assertions, so skip the runner for them (`skipTests`). They still typecheck and still trigger surface invalidation.
- **Typecheck cost.** If typecheck per landing is too slow for 300 agents, batch them: merge up to 10 workload intents, typecheck once, and land one commit that lists all intent ids. Record any batching in DECISIONS.md and keep it honest in the UI ("batch of 10").

## Tests
- Unit tests for the generator:
  - Determinism (same seed gives the same edits).
  - Every edit typechecks.
  - The overlap rate is roughly respected.
- Runner: in memory mode, run `n = 40` and check that every intent ends `landed`, `failed` or `stale`, with no hangs, and that the metrics are consistent.

## Acceptance
```
npm test -- workload
# live: POST /api/admin/workload {"n":300,"seed":7} on the deployed worker -> record in DECISIONS.md: wall time, forks created, landings/min, any rate-limit errors
```
