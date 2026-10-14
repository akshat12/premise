# Script for the screen recording: slides, then the live site

Read this one when you record with the slide deck. (`script.md` is the older cut that uses the site alone.) It is about 1,030 spoken words: about 6:50 of speaking at 150 words a minute, or 7:20 at 140. With the two visits to the site and a breath between slides, the whole take comes to about 8 to 8:30. The rules allow five to ten minutes, so rehearse once with a clock in view. If you are past 8:45 when you reach slide 18, press through it without speaking and go on to slide 19.

**How to read it**

- Plain text is what you say: one short paragraph for each slide, in full sentences. Read it at an easy pace, as if explaining it to a colleague.
- Anything in **[SQUARE BRACKETS]** is something you do, not something you say.
- **[NEXT SLIDE]** means press the right arrow once. Every slide appears complete, all at once, so you can start speaking as soon as it is up. The small moving parts on some slides loop by themselves.
- Pause for a breath between slides.

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

This is Premise. Git keeps track of what AI agents wrote. Premise keeps track of what they assumed, and redoes the work when an assumption breaks.

**[NEXT SLIDE]**

### Slide 2 · The problem

Picture many AI agents changing one codebase at once. The changes that hurt are not the conflicts. Follow one. It touches different files, so there is no conflict. Its signature is the same, so the typecheck passes. Its tests pass too. And yet it is broken, because another agent's code relied on the old behaviour.

**[NEXT SLIDE]**

### Slide 3 · An example

Here is an example. Agent 1 changes a function called verifySession: for an expired session, it used to throw an error, and now it returns null. Agent 2's code catches that error and writes an audit entry. After the change there is nothing to catch, so the entry is never written, and no check notices.

**[NEXT SLIDE]**

## Part two: the six parts (slides 4 to 12)

### Slide 4 · Premise has six parts

Premise has six parts: agents, forks, the ledger, premises, re-derive, and the gate. I will take them one at a time.

**[NEXT SLIDE]**

### Slide 5 · Part 1, agents

First, agents. Each agent works on an Intent: its job, written down. This is Agent 2's: write an audit entry when a login arrives with an expired session. It says what the agent changes, handleLogin, and what it relies on, verifySession. What it relies on are its premises.

**[NEXT SLIDE]**

### Slide 6 · Part 2, forks

Second, forks. No agent works on trunk directly. Each Intent gets its own fork, a Git repository on Cloudflare Artifacts, and only the gate can land work on trunk. One recorded run made three hundred and nine forks.

**[NEXT SLIDE]**

### Slide 7 · Part 3, the ledger

Third, the ledger, a sign-up sheet for the code. Before Agent 1 writes anything, it signs up to change verifySession. The ledger also notes that Agents 2, 3 and 4 rely on it. So when Agent 1's change lands, the ledger already knows who could be affected.

**[NEXT SLIDE]**

### Slide 8 · Part 3, the ledger's three answers

When two agents want the same function, the ledger answers Wait, until the other lands; Split, so each takes a part; or Depend, when one builds on the other. A fixed rule decides, not a model. In practice, it is nearly always Wait.

**[NEXT SLIDE]**

### Slide 9 · Part 4, premises

Fourth, premises. There are three kinds. The types of the functions an agent read, and of the functions it calls, which Premise records by itself. And a behaviour the agent states, as a check that can be run: Agent 2 states that verifySession throws for an expired session. A typecheck sees the first two. Only the third catches a change in behaviour.

**[NEXT SLIDE]**

### Slide 10 · When a premise breaks

Now a premise breaks. Agent 1's change lands, and the stated checks run again. Two fail, so Agents 2 and 4 are stopped within about half a second. Agent 3 relied only on the type, which did not change, so it carries on. Each stopped agent is told what changed, and who changed it.

**[NEXT SLIDE]**

### Slide 11 · Part 5, re-derive

Fifth, re-derive. Take Agent 2. Premise first tries a plain rebase, but Agent 2's tests fail. So the agent does the work again on a fresh fork of the new trunk, told that verifySession now returns null. This time it passes the gate and lands, with no person involved. The work is derived again from the same goal.

**[NEXT SLIDE]**

### Slide 12 · Part 6, the gate

Sixth, the gate, the only way onto trunk. It runs five checks: the typecheck, the agent's own tests, reference checks that no agent can edit, every test already on trunk, and the work's premises. Only when all five pass does the work land.

## Part three: the real thing (the site, then slides 13 to 16)

**[SWITCH TO THE BROWSER: the Demo tab, "Step 01 / 07"]**

That is the idea. Here is a real run on Cloudflare, replayed. The agents are scripted, with no model, but the forks, tests and landings are real.

**[PRESS → ONCE: "Step 02 / 07"]** Each row is one agent's Intent.

**[PRESS →, WAIT FOR THE TAPE TO STOP, PRESS → AGAIN: "Step 04 / 07"]** Agent 1 lands, and Agents 2 and 4 are stopped straight away.

**[PRESS →: "Step 05 / 07"]** Agent 2 is re-derived, and lands.

**[PRESS →: "Step 06 / 07"]** And then there is Agent 4, the case that tests miss.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

### Slide 13 · The case tests miss

Look at Agent 4. After Agent 1's change, its tests, the reference checks and all ninety-one tests on trunk passed. Only its premise failed. Its tests used a stand-in for verifySession that still throws, but the premise is checked against the real function. With tests alone, this would have landed broken. Instead it was re-derived, and all four landed.

**[NEXT SLIDE]**

### Slide 14 · Compared

We put the same twelve tasks through three rules. With a typecheck only, three problems reached trunk. With a queue that runs the tests, one still got through, the kind you just saw. With Premise, none did. To be fair: the breaking change is planted, the agents are scripted, and Premise is the slowest of the three.

**[NEXT SLIDE]**

### Slide 15 · At scale

Under more load, a larger recorded run had three hundred and six Intents, each on its own fork. One gate landed about sixty-one a minute, two hundred and sixty-six in all, in four minutes twenty. No problem reached trunk. Again, all of it is scripted.

**[NEXT SLIDE]**

### Slide 16 · Live

You can try it yourself. On the Live tab, anyone can start a run of twelve scripted agents on real Artifacts. It takes three to four minutes. Every run is kept on the Results tab, and the recent ones each landed every agent, with nothing broken on trunk.

**[SWITCH TO THE BROWSER, THEN CLICK THE "Results" TAB]**

**[CLICK A ROW OF THE LIVE RUNS TABLE THAT SAYS "12 of 12": A PANEL SLIDES IN FROM THE RIGHT]** Here is one of those runs, as it ended.

**[CLICK AGENT 2'S ROW IN THE PANEL]** And for any agent, you can see what it changed, as it landed on trunk.

**[BACK TO THE SLIDES, THEN NEXT SLIDE]**

## Part four: how it is built, and where it would sit (slides 17 to 20)

### Slide 17 · How it is built

Under the hood, Premise is one Worker on Cloudflare. Code lives in Artifacts, and state lives in Durable Objects. Each agent runs as a Workflow, and every test runs in a fresh Dynamic Worker with no network. There are no containers.

**[NEXT SLIDE]**

### Slide 18 · Scaling up

It is a prototype, but already shaped for many agents: a fork per Intent, a ledger split by module, and stops that reach only the agents affected. Next would be many gates instead of one, each checking only what a change can reach, and a UI that stays readable when agents run for hours or days. That part is a design, not a measurement.

**[NEXT SLIDE]**

### Slide 19 · In a bigger system

In a bigger system, tasks still come from people, tickets or an orchestrator, and agents of any kind do the work. Premise sits between those agents and trunk, and CI and deploy carry on as before. It adds one layer and changes nothing else. That is a design too.

**[NEXT SLIDE]**

### Slide 20 · Try it

To sum up: Git tracks what agents wrote, and Premise tracks what they assumed. It is open source, built on Cloudflare Workers and Artifacts. Open the site and press Next, or start a run on the Live tab. Thanks for watching.

**[HOLD FOR FIVE SECONDS, THEN STOP THE SCREEN RECORDING]**
