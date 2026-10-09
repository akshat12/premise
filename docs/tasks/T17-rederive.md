# T17: Re-derive race (with caps and escalation)

**Recommended effort: High.**

## Goal
When an intent goes `stale`, race two attempts and land whichever passes the intent's **immutable** acceptance checks:

- **Rebase path.** Run `gateOne(intent, "rebase")` on the existing fork head against the new trunk, without landing yet: dry-run mode.
- **Re-derive path.**
  1. Create a **fresh fork** of the current trunk named `<id>-r<n>`.
  2. Start an AgentWorkflow in `mode: "rederive"`. The prompt context is the stored goal, the broken premises and their reasons, the previous `why`, and the rejected alternatives.
  3. Gate the result.

Rules:
- If both paths pass, prefer **rederive** when the rebase passed only because assertions were skipped (they never are). Otherwise prefer **rebase**, because it's cheaper. In the demo the rebase fails, so rederive wins honestly.
- After **2** failed re-derive attempts, escalate to a human with `human.needed`, kind `"fallback"`, options `["Retry", "Abandon"]`.
- At most `MAX_CONCURRENT_REDERIVES` (default 3) re-derives run at once. The rest wait in a priority queue. This prevents livelock when trunk moves often.

## Read first
- `CLAUDE.md`
- `docs/SPEC.md`: mechanism step 8
- `src/worker/gate/*`
- `src/worker/agent/workflow.ts` (re-derive prompt block)
- `src/worker/intent/intent-do.ts`

## Files
- `src/worker/gate/rederive.ts`
- Changes to `landing.ts` and `invalidate.ts`

## Design

**Dry-run gate.** Add `opts.dryRun` to `gateOne`. It runs every check but doesn't commit.

**`Rederiver` (lives inside the Landing DO, so a single owner serializes trunk writes).** It keeps two tables:
- `stale_queue(intent_id, priority, since)`
- `running(intent_id, started)`

It runs the following when an intent goes stale. `invalidate` calls `LANDING.noteStale(id)`.
1. If `running` has fewer than the cap, start a race. Otherwise queue the intent.
2. Race steps:
   1. `act({a:"rederive"})`
   2. `incRederive()`
   3. Publish `rederive.race` with both paths `pending`.
3. Run both paths in parallel:
   - **Rebase:** dry-run `gateOne` with path `"rebase"`, then publish the result.
   - **Re-derive:**
     1. `store.fork(currentTrunk, \`${id}-r${n}\`)`
     2. Update the intent (`repo`, `baseCommit`, `headCommit: null`, `premises`). Keep the asserted premises and reset their state to `holding`. Clear the observed and derived premises; the agent re-reads.
     3. Start the workflow with `mode: "rederive"`, instance id `${id}-${n}`.
     4. The workflow ends by calling `LANDING.enqueue(id, "rederive")` instead of `"rebase"`.
4. Resolve the race. The first path that reaches a passing gate result wins.
   - If **rebase** passes first: commit it through the normal landing path and cancel the re-derive workflow (`instance.terminate()`; check the Workflows docs for the exact API).
   - If **re-derive** passes: land it.
   - If both fail:
     - Attempts < 2: the intent stays `stale`. Requeue it.
     - Attempts ≥ 2: `act({a:"escalate"})` and publish `human.needed`.
5. Publish the final `rederive.race` with the winner. Update the metrics: `rederives.started`, `succeeded`, `failed`.
6. When a race ends, start the next queued intent.

**Human choice.**
- `POST /api/human/:id` with `Retry` resets the attempts counter to allow one more try, then starts a race.
- `Abandon` sets the intent to `failed`.

## Tests
- Pure tests of the cap and queue logic: a `RederiveScheduler` class with injected `start()`.
- Workers-pool scenario with memory store plus scripted LLM:
  1. Land t01.
  2. t02 goes stale.
  3. The race runs. The rebase dry-run **fails** on the acceptance test.
  4. The re-derive, using scripted turns in `__scripts__/t02-rederive.json` that add the audit call to the null branch, **passes** and lands.
  5. The events contain `rederive.race` with winner `"rederive"`.
- Escalation: a scripted re-derive that always fails gives exactly 2 attempts, then `escalated` and `human.needed`.
- Cap: 5 intents go stale, and at most 3 run at once.

## Acceptance
```
npm test -- rederive
npm test           # full suite still green
npm run typecheck
```
