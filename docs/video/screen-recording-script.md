# Script for the screen recording: slides, then the live site

Read this one when you record with the slide deck. (`script.md` is the older cut that uses the site alone.) It is about 1,230 spoken words: about 9:00 at 150 words a minute and about 9:40 at 140, with the presses and the two visits to the site. The rules allow five to ten minutes, so rehearse once with a clock in view. If you are past 8:00 when you reach slide 18, press through it without speaking and go on to slide 19.

**How to read it**

- Plain lines are what you say. Read them as written.
- Anything in **[SQUARE BRACKETS]** is something you do, not something you say.
- **[→]** means press the right arrow once. On a slide it brings in the next piece of the picture. Say the line that follows it once the piece has appeared.
- **[NEXT SLIDE]** is also one press of the right arrow: the picture on the current slide is complete, so the press moves on.
- Each slide opens with its first piece already showing, so you can start speaking as soon as it appears.

**Before you press record**

- Window 1: the deck, in Present mode, on slide 1.
- Window 2: Chrome at `https://premise.akshatdivekar.workers.dev/`, page area 1440×900, on the **Demo** tab at "Step 01 / 07". (`shot-list.md` has the browser set-up, with one change: capture the whole screen, not the page area, because this take shows two windows. Put Chrome in full screen instead of using the DevTools device toolbar.) Switch between the two windows with `⌘Tab`.
- Open `https://premise.akshatdivekar.workers.dev/?results` once beforehand. Check that the headline still says the last live runs each landed every agent, with nothing broken on trunk (slide 16 says "the recent live runs", so the number does not matter), and that a row under the top one that says "12 of 12" opens a panel when it is clicked (the top row, the run on the board now, goes to the Live tab instead; some rows are runs of 5 or 7 agents).
- In Present mode, check that slide 15 is "At scale" and slide 19 is "The honest part".
- Do not press **Start a run** during the take: a run takes three to four minutes.

**Words to keep to.** Intent, changes, relies on, premise, re-derive, gate, trunk; Wait, Split, Depend. Say "Agent 1" to "Agent 4". "Premises are the early warning. The gate is the guarantee." is said once, on slide 19. Never say "race".

---

## Part one: the problem (slides 1 to 3)

### Slide 1 · Cover

Git tracks what agents wrote. Premise tracks what they assumed, and re-derives the work the moment an assumption breaks.

**[NEXT SLIDE]**

### Slide 2 · The problem

When many AI coding agents share one codebase, the changes that hurt are not the conflicts. Follow one change.

**[→]** Different files, so there is no conflict.

**[→]** The same signature, so the typecheck passes.

**[→]** Its tests pass. Everything looks fine.

**[→]** And it is still broken: another agent's code relied on the old behaviour.

**[NEXT SLIDE]**

### Slide 3 · An example

Here is that change. Agent 1 changes one function, verifySession. For an expired session it used to throw an error. Now it returns null.

**[→]** Agent 2's code relies on the old way. It catches that error and writes an audit entry.

**[→]** Now nothing is thrown, so the entry is never written.

**[→]** Same signature, different files. Both checks pass.

**[NEXT SLIDE]**

## Part two: the six parts (slides 4 to 12)

### Slide 4 · Premise has six parts

Premise has six parts. Agents, each on a job called an Intent.

**[→]** Forks: a private copy of the code.

**[→]** The ledger: who is changing what.

**[→]** Premises: what each agent relies on.

**[→]** Re-derive: the work done again when a premise breaks.

**[→]** And the gate: every check before trunk, the shared code.

**[NEXT SLIDE]**

### Slide 5 · Part 1, agents

An Intent is an agent's job, written down. This is Agent 2's. Its goal: write an audit entry when a login arrives with an expired session.

**[→]** What it changes: handleLogin.

**[→]** And what it relies on: verifySession. That list is its premises.

**[→]** Every agent's job is written down this way.

**[NEXT SLIDE]**

### Slide 6 · Part 2, forks

No agent works on trunk directly.

**[→]** Every Intent gets its own copy, a fork: a Git repo on Cloudflare Artifacts.

**[→]** There is one way back. Only the gate lands work on trunk.

**[→]** One recorded run made three hundred and nine forks.

**[NEXT SLIDE]**

### Slide 7 · Part 3, the ledger

The ledger is a sign-up sheet for the code. Before an agent writes anything, it says what it will change. Agent 1 signs up for verifySession.

**[→]** What an agent reads or calls is noted too. Agents 2, 3 and 4 rely on verifySession.

**[→]** Every function gets a line.

**[→]** So when Agent 1's change lands, the ledger knows exactly who could be affected.

**[NEXT SLIDE]**

### Slide 8 · Part 3, the ledger's three answers

Sometimes two agents want the same function. The ledger gives one of three answers.

**[→]** Wait: pause until the other lands, then ask again.

**[→]** Split: divide the work.

**[→]** Depend: this work depends on the other, so it pauses too.

**[→]** A fixed rule decides, not a model. If it cannot, a person is asked.

**[→]** In one recorded run it answered a hundred and thirty-six times. Nearly always, Wait.

**[NEXT SLIDE]**

### Slide 9 · Part 4, premises

A premise is something an agent's work relies on. Three kinds. What it read: the type of every function it looked at.

**[→]** What it calls: the type of every function it uses. Both are recorded for it.

**[→]** And what it states: a behaviour, as a check that can be run. Agent 2 states that verifySession throws for an expired session.

**[→]** A typecheck sees the first two. The third is the one it cannot see.

**[NEXT SLIDE]**

### Slide 10 · When a premise breaks

Now a premise breaks. Agent 1 changes verifySession, and the other three rely on it.

**[→]** Agent 1 lands. Every landing runs the stated checks again, and two now fail.

**[→]** In the same second, Agents 2 and 4 are stopped. They relied on the old behaviour.

**[→]** Agent 3 relies only on the type, which did not change. It carries on.

**[→]** Each stopped agent is told what changed and who changed it.

**[NEXT SLIDE]**

### Slide 11 · Part 5, re-derive

What happens to stopped work? Take Agent 2.

**[→]** First, a plain rebase. It takes about a second. Here it is not enough: Agent 2's tests fail.

**[→]** So the agent does the work again, on a fresh fork, told what broke. That is a re-derive.

**[→]** It passes the gate and lands. No person was involved.

**[→]** The Intent is not abandoned. A person is the last resort.

**[NEXT SLIDE]**

### Slide 12 · Part 6, the gate

The gate is the only way onto trunk. Five checks. The typecheck.

**[→]** The tests the agent wrote.

**[→]** Reference checks, which no agent can write or edit.

**[→]** Every test already on trunk.

**[→]** And its premises.

**[→]** Only then does the work land.

## Part three: the real thing (the site, then slides 13 to 16)

**[SWITCH TO THE BROWSER: the Demo tab, "Step 01 / 07"]**

That was the idea. This is a real run on Cloudflare Artifacts, replayed. The agents are scripted: no model. The forks, tests and landings are real.

**[PRESS → ONCE: "Step 02 / 07"]** Each row is an agent's Intent.

**[PRESS →, WAIT FOR THE TAPE TO STOP, PRESS → AGAIN: "Step 04 / 07"]** Agent 1 lands, and Agents 2 and 4 are stopped.

**[PRESS →: "Step 05 / 07"]** Agent 2 is re-derived, and lands.

**[PRESS →: "Step 06 / 07"]** And Agent 4: the case that tests miss.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

### Slide 13 · The case tests miss

Look closely at Agent 4. Its own tests passed, after Agent 1's change.

**[→]** So did the reference checks.

**[→]** So did all ninety-one tests on trunk.

**[→]** One thing failed: its premise.

**[→]** Why? It tested with a stand-in for verifySession, and the stand-in still throws.

**[→]** Its premise was checked against the real function, which now returns null. Tests alone would have landed this, broken. Instead it was re-derived too, and all four landed.

**[NEXT SLIDE]**

### Slide 14 · Compared

We put twelve tasks through three rules. With a typecheck only, three problems reach trunk.

**[→]** With a queue that runs the tests, two go back to a person, and one still reaches trunk: the kind you just saw.

**[→]** With Premise, none reach trunk and none are handed back. To be clear: the break is planted, the agents are scripted, and Premise is the slowest.

**[NEXT SLIDE]**

### Slide 15 · At scale

The same system under load, in a larger recorded run. Three hundred and six Intents, each on its own fork.

**[→]** One gate, landing sixty-one a minute, in batches of ten.

**[→]** Two hundred and sixty-six landed, in four minutes twenty.

**[→]** Problems on trunk: none. No model wrote any of it: it is all scripted.

**[NEXT SLIDE]**

### Slide 16 · Live

You can run it yourself. On the site's Live tab, anyone can start a run: twelve scripted agents, on real Cloudflare Artifacts, in three to four minutes.

**[→]** Every run is kept on the Results tab, whoever started it.

**[→]** And a kept run can be played again.

**[→]** The recent live runs each landed every agent, with nothing broken on trunk.

**[SWITCH TO THE BROWSER, THEN CLICK THE "Results" TAB]**

**[CLICK A ROW OF THE LIVE RUNS TABLE THAT SAYS "12 of 12": A PANEL SLIDES IN FROM THE RIGHT]** Here is one of those runs, as it ended. Twelve agents this time.

**[CLICK AGENT 2'S ROW IN THE PANEL]** And for any agent: its changes, as they landed on trunk.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

## Part four: how it is built, and its limits (slides 17 to 20)

### Slide 17 · How it is built

Premise is one Worker on Cloudflare: the API, the page, and the TypeScript compiler.

**[→]** Code lives in Artifacts: trunk, and a fork for every Intent.

**[→]** State lives in Durable Objects: the ledger, each Intent, the gate, the event log.

**[→]** Each agent is a Workflow.

**[→]** Tests run in Dynamic Workers: a fresh isolate each time, with no network.

**[→]** No containers.

**[NEXT SLIDE]**

### Slide 18 · Scaling up

It is a prototype. Already shaped for many agents: a fork for every Intent,

**[→]** a ledger split by module,

**[→]** targeted stops,

**[→]** and a Workflow for every agent.

**[→]** Next, one gate would become many,

**[→]** and each landing would check less. That is a design, not a measurement.

**[NEXT SLIDE]**

### Slide 19 · The honest part

One more thing, because it is the honest part. Every agent so far was scripted. We ran the same four tasks with a live model as every agent. The premise stopped Agent 4's first attempt, as before. But the model redid the work the same way, and that passed every test and landed. The premise caught the problem once, and the redo let it back in.

Premises are the early warning. The gate is the guarantee.

Since then, the gate turns back a redo identical to the stopped work. The model's second run still let one through. What we changed after that narrows the hole. It does not close it.

**[NEXT SLIDE]**

### Slide 20 · Try it

Git tracks what agents wrote. Premise tracks what they assumed. It is open source, built on Cloudflare Workers and Artifacts. Open it and press Next. Or open the Live tab and press Start.

**[HOLD FOR FIVE SECONDS, THEN STOP THE SCREEN RECORDING]**
