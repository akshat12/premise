# Live on stage, 10 minutes (Oct 21)

Rewritten on Oct 12 for the story page and the new look, and corrected that evening for the two tabs (**Demo** and **Live**): the comparison and the larger run are panels under the story now, and the Live tab says in a sentence what the run is doing. The same story as the video, with a live run in the middle and recorded runs ready behind it. The rule on stage: **never wait for the system. If it has not done the next thing within the time given below, say the fallback line and switch.**

Three things to hold to:

- When the live run starts, say in the same breath that the agents replay scripted turns and the workload is generated. "Live" means the forks, pushes, typechecks, tests and landings are happening now on Artifacts.
- The point of the talk is Agent 4: every test passed after its rebase and only its premise failed. Get there by 4:30 whatever the live run is doing.
- Do not say "race", and do not quote percentages from memory: read the cost from the Compared panel.

## Before you walk on

- Laptop on power, notifications off, browser at 1440×900 or the projector's size (check the top bar is not clipped).
- **Switch public runs off, ten minutes before.** The Live tab has a Start button anyone can press, and someone in the room will. A visitor cannot interrupt a run in progress, but can start a new one the moment yours ends, which clears the board you are pointing at. `curl -X POST https://premise.akshatdivekar.workers.dev/api/admin/public-runs -H "x-admin-token: $(grep '^ADMIN_TOKEN=' .env.deployed | cut -d= -f2-)" -H "content-type: application/json" -d '{"enabled":false}'`. The button then says live runs are switched off; your own command below still works. Turn it on again afterwards with `{"enabled":true}`.
- **Tab 1, live:** `https://premise.akshatdivekar.workers.dev/?live`, already reset (`npm run demo -- --url https://premise.akshatdivekar.workers.dev --workload 100 --no-open` is typed in a terminal but not yet run).
- **Tab 2, the story:** `https://premise.akshatdivekar.workers.dev/` (the Demo tab). It opens held on step 1; nothing to pause. The Compared and At scale panels are under the four rows: scroll inside the page.
- **Tab 3, the larger recorded run:** `https://premise.akshatdivekar.workers.dev/?demo=scale`.
- **Tab 4, the live-model replay:** `https://premise.akshatdivekar.workers.dev/?demo=live`, on its last step.
- **Tab 5, offline fallback:** `npm run demo:offline` is running; `http://localhost:4173/?demo=main`. This tab works with no network at all, and `?demo=scale` and `?demo=live` work there too.
- A terminal, large type, in the repo folder, with `.env.deployed` present. Never show that file.
- Run the whole thing once on the venue's network before the session.

## Running order

| Time | Do | Say (in short) | If it fails |
|---|---|---|---|
| 0:00 | Tab 2. Click the fourth segment: "Step 04 / 07". | The cold open from `script.md`: two agents had the ground move under them; same signature, typecheck green, no conflict; Premise stopped them because each had recorded what it relied on. The tagline. | Nothing to fail: it is a replay. |
| 1:00 | Tab 1 (live board, empty). Run the command in the terminal. The sentence at the top changes to "Starting a run."; twelve rows and the workload row appear within about 20 seconds. | "This is live, on Cloudflare Artifacts, right now: twelve agents and a hundred scripted workload Intents, each on its own fork. The agents replay scripted turns and the workload is generated; the forks, pushes, typechecks, tests and landings are real." Explain an Intent: goal, changes, relies on. | **No rows after 15 seconds, or an error in the terminal:** "The network is not with us; here is the same system, recorded." Go to Tab 3 and press **Play**. If it does not load, Tab 5. Carry on with the recorded run. |
| 2:00 | Watch for Agent 1 landing (about 25 to 40 seconds after the rows appear). An orange line drops through Agents 2, 3 and 11, they say "stopped", and the sentence at the top reads "Three agents relied on how it used to behave. They are stopped at once." | The premise break, as in the script. "Broken builds on trunk" is 0. | **Nothing stopped 60 seconds after dispatch:** "Let me show you the moment itself." Tab 2 is already on it. Stay on the recorded runs from here. |
| 3:15 | Click Agent 2's row. The details panel shows the rebase failing and the re-derive passing, and the row gets an R1 stamp. | Re-derive: the plain rebase is tried first and the gate turns it away; the agent does the work again from the Intent on a fresh fork; it lands. Nobody was involved. | **Agent 2 still "re-deriving" after 60 seconds:** "The live one is taking its time; here is how it ends." Tab 2, `→` once (step 5). |
| 4:30 | Tab 2. Click the sixth segment: Agent 4's readout. Then click the row and point at the **Changes** column. | The point of the talk: its tests, the reference checks and every existing test passed; only its premise failed. "It is the assumption your stand-in encodes, checked against the real thing." | Static. |
| 6:00 | Tab 1: the live run's own sentence and counters, if it has finished ("All twelve agents' work landed. Nothing broken reached trunk."). Then Tab 2, scrolled down to the **At scale** panel, with **More numbers** open. | The numbers on screen. One gate, batches of ten for the workload. The ledger's three answers: Wait, Split or Depend. | If the live run has not finished, go straight to Tab 2. |
| 7:00 | Tab 2, scrolled to the **Compared** panel (just above At scale), with "What Premise costs" in view. | Three rules: 3, 1 and 0 regressions; the queue with tests sends two tasks back and ships the third. The scenario is planted. Read the cost from the screen. | Static. |
| 8:00 | Tab 4: "The run is over. One problem reached trunk." | The honest part, as in the script's live-model row. "Premises are the early warning. The gate is the guarantee." | Static. |
| 9:00 | Architecture (`docs/architecture.svg`). | One Worker, Artifacts, a Workflow for each agent, four kinds of Durable Object, TypeScript in the Worker, Dynamic Workers for tests. No containers. | Static. |
| 9:30 | End frame. | The tagline, the repo, "open it and press Next". Questions. | |

## What can go wrong, and what to do

- **The venue network drops entirely.** Tab 5 (offline). Say "this is the recorded run" once and move on. Every beat except the live dispatch works.
- **The live run stalls with Intents "queued".** The gate may still be working: a 100-Intent workload takes two to three minutes to drain. The agents' twelve rows land first; do not wait for the workload.
- **A line asking a person appears live** ("Agent 5 and Agent 6 both want computeTotal"). The ledger could not settle it and asks Wait / Split / Depend. Say so in a sentence and leave it; it closes by itself when Agent 6 lands.
- **Someone asks to see it with a real model.** Tab 4 is exactly that, and say what is true: four agents with a live model have run twice on Cloudflare; all four landed both times, and both times one regression reached trunk, because the model redid stopped work without fixing it. The stage run uses scripted turns so it cannot be slowed down by a provider's rate limit.
- **Reset between rehearsals:** `npm run demo` resets before it dispatches. To reset without dispatching, use the "Reset demo" command in `⌘K` (it asks for the admin token in the dispatch panel; type it before the audience arrives).
- **The simplest live run of all:** with public runs on, press **Start a run** on the Live tab. No terminal. It is twelve agents and thirty workload Intents, and takes three to four minutes. Use it if the terminal misbehaves; the reason not to make it the plan is the one above, that anyone else can press it too.

## Offline fallback

```bash
npm run demo:offline        # builds, then serves http://localhost:4173/?demo=main with no backend
```

This serves the built UI as plain files. The recorded run is inside the build, and the fonts are too. `npx vite preview` is **not** a fallback: it starts the Worker, which needs a Cloudflare login and a network connection.
