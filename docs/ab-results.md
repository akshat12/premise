# A/B: two queues, and Premise

**A queue that only typechecks shipped 3 behavioural regressions and sent 0 of 12 tasks back to a person; a queue that also runs the tests shipped 1 behavioural regression and sent 2 of 12 tasks back to a person; Premise shipped 0 behavioural regressions and sent 0 of 12 tasks back to a person.**

Run on 2026-10-11 against http://localhost:5173. Every rule ran the same 12 demo tasks and the same scripted workload (100 Intents), each on its own fresh copy of trunk, for seeds 7, 11, 23. Where the seeds disagree, a cell gives the lowest and the highest value.

- **Typecheck only** lands whatever rebases cleanly and typechecks. No tests, no claims, no premises, no re-derive.
- **Queue with tests** also runs the change's own tests, the task's reference checks and every test already on trunk, after the rebase. This is the fair comparison: it is what a careful team's queue does. It still has no claims, no premises and no re-derive, so what it turns away goes back to its author.
- **Premise** is the full system: the ledger, premises and invalidation, the gate (typecheck, the same three kinds of test, premise assertions, the checks landed Intents left behind), and re-derive.
- The rebase, the typecheck and the test runner are the same code in all three. Only the landing rule differs.

## What is built into the scenario

Read the table knowing how the run is set up. None of this is hidden in the code, and none of it is a measurement of real teams.

- **The breaking change is planted and lands first.** One task changes how `verifySession` reports an expired session; three others are written against the old behaviour. The run holds the other eleven tasks at the gate until that one has landed, in every mode, so all three modes see the same order.
- **Two of the three dependents have tests that catch it.** After the rebase their own tests fail, so a queue that runs tests turns them away just as Premise does. The difference there is what happens next: the queue stops, and Premise re-derives the work and lands it.
- **The third dependent is the case tests miss, and it is built to be.** Its tests check the rate limiter with a stand-in for the session check, the way unit tests often do. The stand-in still throws, so every test passes after the rebase while the real path is broken. Only its premise (an executable assertion about the real `verifySession`) fails. An end-to-end probe that no rule runs before landing is what counts it as a regression.
- **The agents here are scripted.** Their turns are generated from the reference solutions, including the assertion each dependent makes. Whether a model makes that assertion unprompted is a separate question; see the README.
- **The workload's collisions are generated.** One scripted edit in ten is aimed at a function another edit touches. The row about workload Intents that did not land shows the same collisions under each rule.

| | Typecheck only | Queue with tests | Premise |
|---|---|---|---|
| Behavioural regressions that reached trunk | 3 | 1 | 0 |
| Demo tasks sent back to a person | 0 of 12 | 2 of 12 | 0 of 12 |
| Stale Intents redone and landed with nobody involved | 0 | 0 | 3 |
| Broken builds on trunk | 0 | 0 | 0 |
| Scripted workload Intents that did not land | 5 to 8 | 7 to 9 | 9 to 12 |
| Human merges | 5 to 8 | 7 to 9 | 0 |
| Intents landed | 104 of 112 to 107 of 112 | 101 of 112 to 103 of 112 | 100 of 112 to 103 of 112 |
| Premises broken | 0 | 0 | 22 to 44 |
| Stale Intents a plain rebase settled | 0 | 0 | 13 to 22 |
| False positives: agents | n/a | n/a | 0% (0 of 5) to 50% (3 of 6) |
| False positives: scripted workload | n/a | n/a | 94% (16 of 17) to 100% (21 of 21) |
| Turned away at the gate | 5 text, 0 type, 0 checks to 8 text, 0 type, 0 checks | 7 text, 0 type, 2 checks to 9 text, 0 type, 2 checks | 3 text, 0 type, 3 checks to 4 text, 0 type, 2 checks |
| Gave up waiting for a claim | 0 | 0 | 5 to 9 |
| Landings per minute | 790.7 to 816.9 | 625.5 to 652.2 | 481.0 to 497.5 |
| Wall time | 7.8 s to 7.9 s | 9.5 s to 9.7 s | 12.1 s to 12.5 s |
| Reference checks and probes red at the end | 3 | 1 | 0 |
| Forks created | 112 | 112 | 115 to 117 |

## What the numbers mean

- **Behavioural regressions that reached trunk.** Reference checks and end-to-end probes of landed tasks that went red after a landing. No rule runs the probes before landing; they stand for what the running system does.
- **Demo tasks sent back to a person.** Tasks whose work did not land and that nothing will pick up again. The two queues turn the work away and stop there. Premise re-derives it, and asks a person only after two re-derives have failed.
- **Stale Intents redone and landed with nobody involved.** Re-derives that landed. The two queues have no such step.
- **Broken builds on trunk.** Typecheck failures after a landing. All three rules typecheck before landing.
- **Scripted workload Intents that did not land.** The workload aims one edit in ten at a function another edit touches, on purpose. In the two queues that becomes a text conflict for a person to merge. In Premise the ledger makes the later Intent wait, and a scripted Intent gives up after three more tries. Either way the work is not on trunk.
- **Human merges.** Text conflicts someone has to merge by hand (the two queues), or Intents that ended with a person (Premise). A scripted Intent that gave up on a claim is not a merge, and is counted in the row above.
- **Intents landed.** Agents and scripted workload together.
- **Premises broken.** The two queues have no premises, so nobody is told.
- **False positives: agents.** Of the agents' Intents that went stale, the share whose plain rebase then passed the whole gate: the broken premise cost time and changed nothing.
- **False positives: scripted workload.** The same for the scripted workload. These Intents have no tests or assertions of their own, so a stale one whose rebase is clean and passes trunk's suite always counts here. Read it as the cost of treating every type-surface change as a broken premise.
- **Turned away at the gate.** Text conflicts, type errors after rebase, and failed tests or assertions (the first rule runs neither).
- **Gave up waiting for a claim.** Premise only: the two queues have no ledger.

## Red on trunk at the end: A queue that only typechecks, seed 7

- `premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired`
- `premise/hidden-tests/t03-expired-metrics.test.ts#a request with an expired session is counted`
- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`

## Red on trunk at the end: A queue that also runs the tests, seed 7

- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`

## Red on trunk at the end: A queue that only typechecks, seed 11

- `premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired`
- `premise/hidden-tests/t03-expired-metrics.test.ts#a request with an expired session is counted`
- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`

## Red on trunk at the end: A queue that also runs the tests, seed 11

- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`

## Red on trunk at the end: A queue that only typechecks, seed 23

- `premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired`
- `premise/hidden-tests/t03-expired-metrics.test.ts#a request with an expired session is counted`
- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`

## Red on trunk at the end: A queue that also runs the tests, seed 23

- `premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request`
