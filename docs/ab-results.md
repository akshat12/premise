# A/B: how teams land work today, versus Premise

**Baseline shipped 3 behavioural regressions and needed 11 human merges; Premise shipped 0 behavioural regressions and needed 0 human merges.**

Run on 2026-10-10 against https://premise.akshatdivekar.workers.dev. Both modes ran the same 12 demo tasks and the same scripted workload (100 Intents, seed 7), each on its own fresh copy of trunk.

- **Baseline** is a modern queue with a typecheck: fork, push, and land if the textual rebase is clean and the result typechecks. No claims, no premises, no re-derive.
- **Premise** is the full system: the ledger, premises and invalidation, the gate (typecheck, acceptance tests, assertions, landed checks), and re-derive.
- The rebase function and the typecheck are the same code in both. Only the landing rule differs.

| | Baseline | Premise |
|---|---|---|
| Behavioural regressions that reached trunk | 3 | 0 |
| Human merges | 11 | 0 |
| Broken builds on trunk | 0 | 0 |
| Demo tasks landed | 12 of 12 | 12 of 12 |
| Intents landed | 100 of 111 | 97 of 112 |
| Landings per minute | 50.8 | 42.1 |
| Wall time | 118.1 s | 138.2 s |
| Premises broken | 0 | 27 |
| Stale Intents settled by re-derive | 0 | 3 |
| Stale Intents a plain rebase settled | 0 | 16 |
| False-positive rate | n/a | 76% |
| Turned away at the gate | 11 text, 0 type, 0 checks | 0 text, 0 type, 3 checks |
| Gave up waiting for a claim | 0 | 15 |
| Reference tests red at the end | 3 | 0 |
| Forks created | 111 | 115 |

## What the numbers mean

- **Behavioural regressions that reached trunk.** Reference tests of landed tasks that went red after a landing.
- **Human merges.** Baseline: text conflicts someone has to merge by hand. Premise: Intents that could not move without a person, plus stalemate cards a person answered. A stalemate card that resolved by itself is not counted.
- **Broken builds on trunk.** Typecheck failures after a landing. Both rules typecheck before landing.
- **Intents landed.** Agents and scripted workload together.
- **Premises broken.** Baseline has no premises, so nobody is told.
- **False-positive rate.** Share of stale Intents whose plain rebase passed anyway: the premise break cost time and changed nothing.
- **Turned away at the gate.** Text conflicts, type errors after rebase, and (Premise only) failed acceptance checks or assertions.
- **Gave up waiting for a claim.** Scripted workload Intents that wanted a symbol another Intent was changing, asked three more times, and stopped. In the baseline the same collisions show up as text conflicts for a person.

## Reference tests red on trunk at the end (Baseline)

- `premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired`
- `premise/hidden-tests/t03-expired-metrics.test.ts#a request with an expired session is counted`
- `premise/hidden-tests/t11-expired-rate-limit.test.ts#requests with an expired session count against the limit`
