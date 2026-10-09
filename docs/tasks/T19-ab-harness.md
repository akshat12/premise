# T19: A/B harness (baseline vs Premise) and metrics

## Goal
Produce the headline numbers by running the **same task set and the same workload seed** in two modes.

| | Baseline (how teams work today) | Premise |
|---|---|---|
| Ledger claims | None | Full system |
| Premises / invalidation | None | Yes |
| Re-derive | None | Yes |
| Per agent | Fork, push, land | Same as normal operation |
| Landing rule | Textual three-way rebase; if no text conflict and **typecheck passes**, land. The equivalent of a modern queue with CI typecheck. | Gate (typecheck, tests, assertions), plus invalidation and re-derive |
| Text conflicts | Count as **human merge resolutions** (would need a person) | Count as human merges only if they reach escalation |

Run the **hidden reference tests** (`demo-repo/premise/hidden-tests/`) against final trunk, and against trunk after every landing, to count behavioural regressions that reached trunk.

Metrics per mode:
- `humanMerges`
- `brokenBuildsOnTrunk`, i.e. typecheck failures after landing. Should be 0 in both modes; report it anyway.
- `behaviouralRegressionsOnTrunk`, i.e. hidden tests that went red after a landing.
- `landingsPerMinute`
- `premisesBroken`
- `falsePositiveRate`: share of re-derives whose final diff was textually identical to the rebased diff, or where the rebase path also passed. Report it honestly.
- `forksCreated`
- `wallTimeMs`

## Read first
- `CLAUDE.md`
- `docs/SPEC.md`: "Proof of scale"
- `src/worker/gate/*`
- `src/worker/workload/*`
- `demo-repo/premise/hidden-tests/`

## Files
- `src/worker/ab/run.ts`
- `src/worker/ab/report.ts` (pure)
- Route `POST /api/admin/ab`
- Script `scripts/ab.ts` (calls the route, writes `docs/ab-results.json` and `docs/ab-results.md`)

## Design
- Each mode runs on its **own trunk copy**:
  - `trunk-base-<run>` and `trunk-prem-<run>`, made by forking the pristine trunk.
  - Pass the trunk name explicitly (`opts.trunk`) through dispatch, gate, invalidation and workload. If any of these still reads `currentTrunk(env)`, refactor it to accept an override.
- LLM agents in both modes run the same 12 tasks.
  - Use `LLM=scripted` for reproducibility, with scripts recorded from a real run (T23 `RecordingLlm`).
  - Optionally run live with `--live`.
- Workload: the same `seed` and `n` in both modes. Default `n = 100` for A/B. Use 300 only for the scale view.
- Baseline mode must use **the same textual rebase function** (`threeWayRebase`) and **the same typecheck**. Only the landing rule differs. Fairness matters; a judge will ask.

## Report (pure, unit-tested)
`buildReport(baseline: Metrics & extras, premise: Metrics & extras): { table: Row[]; headline: string }`

The headline is generated from the numbers, e.g. "Baseline shipped 2 behavioural regressions and needed 7 human merges; Premise shipped 0 and needed 1." Never hard-code it.

## Acceptance
```
npm test -- ab      # report unit tests; memory-mode A/B with n=30 completes and baseline.behaviouralRegressionsOnTrunk >= 1 (the t02/t03 scenario guarantees it)
npx tsx scripts/ab.ts --url $URL     # writes docs/ab-results.{json,md}
```
