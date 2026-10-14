# Script for the screen recording: slides, then the live site

Read this one when you record with the slide deck. (`script.md` is the older cut that uses the site alone.) It is about 920 spoken words: about 7:05 at 150 words a minute and about 7:35 at 140, with the presses and the two visits to the site. The rules allow five to ten minutes, so rehearse once with a clock in view. If you are past 8:30 when you reach slide 18, press through it without speaking and go on to slide 19.

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
- In Present mode, check that slide 15 is "At scale" and slide 19 is "In a bigger system" and slide 20 is "Try it".
- Do not press **Start a run** during the take: a run takes three to four minutes.

**Words to keep to.** Intent, changes, relies on, premise, re-derive, gate, trunk; Wait, Split, Depend. Say "Agent 1" to "Agent 4". Never say "race".

---

## Part one: the problem (slides 1 to 3)

### Slide 1 · Cover

Git tracks what agents wrote. Premise tracks what they assumed.

**[NEXT SLIDE]**

### Slide 2 · The problem

When many AI agents share one codebase, the worst changes are not the conflicts. Follow one.

**[→]** Different files: no conflict.

**[→]** Same signature: the typecheck passes.

**[→]** Its tests pass.

**[→]** And it is still broken. Another agent relied on the old behaviour.

**[NEXT SLIDE]**

### Slide 3 · An example

Agent 1 changes a function, verifySession. For an expired session it used to throw an error. Now it returns null.

**[→]** Agent 2's code catches that error and writes an audit entry.

**[→]** Now nothing is thrown, so the entry is never written.

**[→]** And every check passes.

**[NEXT SLIDE]**

## Part two: the six parts (slides 4 to 12)

### Slide 4 · Premise has six parts

Premise has six parts. Agents, each with a job called an Intent.

**[→]** Forks: a private copy of the code.

**[→]** The ledger: who is changing what.

**[→]** Premises: what each agent relies on.

**[→]** Re-derive: redoing work when a premise breaks.

**[→]** And the gate: the checks before trunk, the shared code.

**[NEXT SLIDE]**

### Slide 5 · Part 1, agents

An Intent is an agent's job, written down. This is Agent 2's: write an audit entry for an expired login.

**[→]** What it changes: handleLogin.

**[→]** What it relies on: verifySession. Those are its premises.

**[→]** Every agent has one.

**[NEXT SLIDE]**

### Slide 6 · Part 2, forks

No agent works on trunk directly.

**[→]** Each Intent gets a fork: its own Git repo on Cloudflare Artifacts.

**[→]** Only the gate lands work on trunk.

**[→]** One recorded run made three hundred and nine forks.

**[NEXT SLIDE]**

### Slide 7 · Part 3, the ledger

The ledger is a sign-up sheet for the code. Agent 1 signs up to change verifySession.

**[→]** Agents 2, 3 and 4 rely on it. That is noted too.

**[→]** Every function gets a line.

**[→]** So when Agent 1's change lands, the ledger knows who could be affected.

**[NEXT SLIDE]**

### Slide 8 · Part 3, the ledger's three answers

When two agents want the same function, the ledger gives one of three answers.

**[→]** Wait: pause until the other lands.

**[→]** Split: divide the work.

**[→]** Depend: it needs the other's work first, so it pauses.

**[→]** A fixed rule decides, not a model.

**[→]** In one recorded run, the answer was nearly always Wait.

**[NEXT SLIDE]**

### Slide 9 · Part 4, premises

A premise is something an agent's work relies on. There are three kinds. The types of the functions it read.

**[→]** The types of the functions it calls.

**[→]** And a behaviour it states, as a check that can be run. Agent 2 states that verifySession throws for an expired session.

**[→]** A typecheck cannot see that third kind.

**[NEXT SLIDE]**

### Slide 10 · When a premise breaks

Now a premise breaks.

**[→]** Agent 1 lands. The stated checks run again, and two fail.

**[→]** Agents 2 and 4 are stopped at once.

**[→]** Agent 3 relies only on the type, which did not change. It carries on.

**[→]** Each stopped agent is told what changed.

**[NEXT SLIDE]**

### Slide 11 · Part 5, re-derive

What happens to stopped work? Take Agent 2.

**[→]** First, a plain rebase. Here it is not enough: the tests fail.

**[→]** So the agent redoes the work on a fresh fork, knowing what broke. That is a re-derive.

**[→]** It passes the gate and lands.

**[→]** No person was needed.

**[NEXT SLIDE]**

### Slide 12 · Part 6, the gate

The gate is the only way onto trunk. Five checks. The typecheck.

**[→]** The agent's own tests.

**[→]** Reference checks, which no agent can edit.

**[→]** Every test already on trunk.

**[→]** And its premises.

**[→]** Only then does the work land.

## Part three: the real thing (the site, then slides 13 to 16)

**[SWITCH TO THE BROWSER: the Demo tab, "Step 01 / 07"]**

This is a real run on Cloudflare Artifacts, replayed. The agents are scripted, with no model. The forks, tests and landings are real.

**[PRESS → ONCE: "Step 02 / 07"]** Each row is an agent's Intent.

**[PRESS →, WAIT FOR THE TAPE TO STOP, PRESS → AGAIN: "Step 04 / 07"]** Agent 1 lands, and Agents 2 and 4 are stopped.

**[PRESS →: "Step 05 / 07"]** Agent 2 is re-derived, and lands.

**[PRESS →: "Step 06 / 07"]** And Agent 4: the case tests miss.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

### Slide 13 · The case tests miss

Look at Agent 4. After Agent 1's change, its own tests passed.

**[→]** So did the reference checks.

**[→]** So did every test on trunk.

**[→]** Only its premise failed.

**[→]** Why? Its tests used a stand-in for verifySession, and the stand-in still throws.

**[→]** The premise is checked against the real function. Tests alone would have landed this broken. Instead it was re-derived, and all four landed.

**[NEXT SLIDE]**

### Slide 14 · Compared

We ran twelve tasks under three rules. With a typecheck only, three problems reach trunk.

**[→]** With a queue that runs the tests, one still reaches trunk.

**[→]** With Premise, none do. To be clear: the break is planted, the agents are scripted, and Premise is the slowest.

**[NEXT SLIDE]**

### Slide 15 · At scale

A larger recorded run: three hundred and six Intents.

**[→]** One gate, landing sixty-one a minute.

**[→]** Two hundred and sixty-six landed, in four minutes twenty.

**[→]** Problems on trunk: none. All of it scripted.

**[NEXT SLIDE]**

### Slide 16 · Live

You can run it yourself. On the Live tab, anyone can start a run of twelve scripted agents on real Artifacts.

**[→]** Every run is kept on the Results tab.

**[→]** A kept run can be played again.

**[→]** The recent live runs each landed every agent, with nothing broken on trunk.

**[SWITCH TO THE BROWSER, THEN CLICK THE "Results" TAB]**

**[CLICK A ROW OF THE LIVE RUNS TABLE THAT SAYS "12 of 12": A PANEL SLIDES IN FROM THE RIGHT]** Here is one of those runs, as it ended.

**[CLICK AGENT 2'S ROW IN THE PANEL]** And for any agent: its changes, as they landed on trunk.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

## Part four: how it is built, and where it would sit (slides 17 to 20)

### Slide 17 · How it is built

Premise is one Worker on Cloudflare.

**[→]** Code lives in Artifacts.

**[→]** State lives in Durable Objects.

**[→]** Each agent is a Workflow.

**[→]** Tests run in Dynamic Workers, with no network.

**[→]** No containers.

**[NEXT SLIDE]**

### Slide 18 · Scaling up

It is a prototype, but shaped for many agents: a fork for every Intent,

**[→]** a ledger split by module,

**[→]** targeted stops,

**[→]** and a Workflow for every agent.

**[→]** Next, one gate would become many,

**[→]** and each landing would check less. That is a design, not a measurement.

**[NEXT SLIDE]**

### Slide 19 · In a bigger system

Where would Premise sit in a bigger system? Tasks come in, and agents of any kind do the work.

**[→]** Premise goes between the agents and trunk.

**[→]** Work whose premise broke is stopped early and re-derived.

**[→]** CI and deploy run as before.

**[→]** One layer is added. The rest stays as it is. This part is a design too.

**[NEXT SLIDE]**

### Slide 20 · Try it

Git tracks what agents wrote. Premise tracks what they assumed. It is open source, built on Cloudflare Workers and Artifacts. Open it and press Next, or start a run on the Live tab.

**[HOLD FOR FIVE SECONDS, THEN STOP THE SCREEN RECORDING]**
