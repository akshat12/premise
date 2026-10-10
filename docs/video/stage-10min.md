# Live on stage, 10 minutes (Oct 21)

The same story as the video, with a live run in the middle and a recorded run ready behind it. The rule on stage: **never wait for the system. If it has not done the next thing within the time given below, say the fallback line and switch.**

## Before you walk on

- Laptop on power, notifications off, browser at 1440×900 or the projector's size (check the top bar is not clipped; below 1400 px wide the trunk sha hides by design).
- **Tab 1:** `https://premise.akshatdivekar.workers.dev/?live`, already reset (`npm run demo -- --url https://premise.akshatdivekar.workers.dev --workload 100 --no-open` is typed in a terminal but not yet run).
- **Tab 2:** `https://premise.akshatdivekar.workers.dev/?demo=main`, paused at the start (`Space`).
- **Tab 3, offline fallback:** `npm run demo:offline` is running; `http://localhost:4173/?demo=main`, paused at the start. This tab works with no network at all.
- A terminal, large type, in the repo folder, with `.env.deployed` present. Never show that file.
- Run the whole thing once on the venue's network before the session.

## Running order

| Time | Do | Say (in short) | If it fails |
|---|---|---|---|
| 0:00 | Tab 2, A/B tab. | The hook from `script.md`: the same work landed two ways; 3 regressions and 11 human merges against 0 and 0. The tagline. | Nothing to fail: it is static. |
| 1:00 | Tab 1 (live board, empty). Run the command in the terminal. Twelve strips and the workload strip appear within about 10 seconds. | "This is live, on Cloudflare Artifacts, right now. Twelve agents, a hundred scripted workload Intents, each on its own fork." Explain an Intent: goal, changes, relies on. | **No strips after 15 seconds, or an error in the terminal:** "The network is not with us; here is the same run recorded last week." Go to Tab 2, press `Space` to play. If Tab 2 does not load, Tab 3. Carry on from the next row with the recorded run. |
| 2:00 | Watch for T01 landing (about 25 to 40 seconds after dispatch). T02, T03, T11 go red. Hover the `verifySession` ledger row. | The premise break, as in the script: same signature, typecheck green, no text conflict, three Intents stale because the behaviour they recorded as a premise no longer holds. Broken builds on trunk: 0. | **No red strips 60 seconds after dispatch:** "Let me show you the moment itself." Tab 2, `→` twice. Stay on the recorded run from here. |
| 3:30 | Click T02. Watch the race rows: rebase ✗, re-derive ✓, R1. | Re-derive: the rebase is turned away by the gate; the agent runs again from the Intent on a fresh fork; it lands. "Premises are the early warning; the gate is the guarantee." | **T02 still "re-deriving" after 60 seconds:** "The live one is taking its time; here is how it ends." Tab 2, `→` three times (T02's race won). |
| 5:00 | Tab 2 (recorded), `Space` then `→` once: the stalemate card. Click T05. | Collision, Split, trespass, quarantine, the card. A person can click; here nobody had to. | Static. |
| 6:00 | Tab 2, `→` once, click T02: the drawer. | The three sources of a premise; why the type surface and not the body; behaviour lives in assertions. | Static. |
| 7:00 | Tab 1 if the live run finished (all green), otherwise Tab 2 at the end (`→` to the end). Scale tab. | The scale numbers on screen. Say plainly: the workload is scripted, the forks and pushes and landings are real; live agents here replay recorded turns so the demo is repeatable. | Use whichever tab has finished. The recorded run's numbers are in `script.md`. |
| 8:00 | Tab 2, A/B tab, scrolled to "What it cost". | The honest numbers: 17% slower, 76% false-positive rate, and why that trade is right. | Static. |
| 9:00 | Architecture (`docs/architecture.svg`). | One Worker, Artifacts, a Workflow for each agent, four kinds of Durable Object, TypeScript in the Worker, Dynamic Workers for tests. No containers. | Static. |
| 9:30 | End frame. | The tagline, the repo, "open the recorded run and press the right arrow". Questions. | |

## What can go wrong, and what to do

- **The venue network drops entirely.** Tab 3 (offline). Say "this is the recorded run" once and move on. Every beat except the live dispatch works.
- **The live run stalls with Intents "queued".** The gate may still be working: a 100-Intent workload takes two to three minutes to drain. The agents' twelve strips land first; do not wait for the workload.
- **A human card appears live.** That is the stalemate card for T05 and T06. It is part of the story (5:00 row). Leave it; it closes when T06 lands.
- **Someone asks to see it with a real model.** Say what is true: the pipeline has been run with a live model on a handful of tasks, including a premise break that the model re-derived; the stage run uses recorded turns so it cannot be slowed down by a provider's rate limit.
- **Reset between rehearsals:** `npm run demo` resets before it dispatches. To reset without dispatching, use the "Reset demo" command in `⌘K` (it asks for the admin token in the dispatch panel; type it before the audience arrives).

## Offline fallback

```bash
npm run demo:offline        # builds, then serves http://localhost:4173/?demo=main with no backend
```

This serves the built UI as plain files. The recorded run is inside the build, and the fonts are too. `npx vite preview` is **not** a fallback: it starts the Worker, which needs a Cloudflare login and a network connection.
