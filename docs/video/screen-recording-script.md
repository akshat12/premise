# Script for the screen recording: slides, then the live site

Read this one when you record with the slide deck. (`script.md` is the older cut that uses the site alone.) It is about 1,080 spoken words: around 7 to 7.5 minutes of talking, and about 8.5 minutes for the whole take with the demo. The rules allow five to ten minutes, so rehearse once with a clock in view.

**How to read it**

- Plain text is what you say: one short paragraph for each slide. Say it the way you would explain it to a friend; it does not have to be word for word.
- Anything in **[SQUARE BRACKETS]** is something you do, not something you say.
- **[NEXT SLIDE]** means press the right arrow once. Every slide appears complete, all at once, so you can start speaking as soon as it is up. The small moving parts on some slides loop by themselves.
- Pause for a breath between slides.

**Before you press record**

- Window 1: the deck, in Present mode, on slide 1.
- Window 2: Chrome at `https://premise.akshatdivekar.workers.dev/`, page area 1440×900, on the **Demo** tab at "Step 01 / 07". (`shot-list.md` has the browser set-up, with one change: capture the whole screen, not the page area, because this take shows two windows. Put Chrome in full screen instead of using the DevTools device toolbar.) Switch between the two windows with `⌘Tab`.
- Open `https://premise.akshatdivekar.workers.dev/?results` once beforehand. Check that the headline still says the last live runs each landed every agent, with nothing broken on trunk, and that a row under the top one that says "12 of 12" opens a panel when it is clicked (the top row, the run on the board now, goes to the Live tab instead; some rows are runs of 5 or 7 agents).
- In Present mode, check that the last slide, 17, is "Demo". The take ends in the browser, not on a slide.
- Do not press **Start a run** during the take: a run takes three to four minutes.

**Words to keep to.** Intent, changes, relies on, premise, re-derive, gate, trunk; Wait, Split, Depend. Say "Agent 1" to "Agent 4". Never say "race".

---

## Part one: the problem (slides 1 to 3)

### Slide 1 · Title

Hi, I'm Akshat, and this is Premise. Git keeps track of what AI agents write. Premise keeps track of what they assume, and when one of those assumptions stops being true, it redoes the work that depended on it.

**[NEXT SLIDE]**

### Slide 2 · The problem

Imagine a bunch of AI agents all working on the same codebase at once. You'd think the big risk is two agents editing the same lines. It isn't. The scary change is the quiet one: it touches different files, so there's no conflict. The types still line up, so it compiles. Its tests pass. Everything looks green, and it's still broken, because some other agent was counting on the old behaviour.

**[NEXT SLIDE]**

### Slide 3 · An example

Here's a real example. Agent 1 changes a function called verifySession. It used to throw an error when a session expired. Now it just returns null. But Agent 2 wrote code that catches that error and writes an audit entry. After the change, there's no error to catch, so the audit entry quietly never gets written. And nothing complains.

**[NEXT SLIDE]**

## Part two: how Premise works (slides 4 to 11)

### Slide 4 · Agents

So how does Premise handle this? It starts with the agents. Each agent gets an Intent, which is just its job, written down. For Agent 2, that's: write an audit entry when someone logs in with an expired session. The Intent also says what the agent will change, here handleLogin, and what it relies on, here verifySession. Those things it relies on are called its premises.

**[NEXT SLIDE]**

### Slide 5 · Two kinds of Intent

There are actually two kinds of Intent. An agent Intent is a real task, like a ticket: an agent reads the code, writes the change and its tests, and says what it relies on. A workload Intent is much simpler: a small edit made by a script, with no agent and no AI. Those are just background traffic, so we can see how Premise holds up when lots of changes are landing at once. Both kinds go through the same ledger and the same gate.

**[NEXT SLIDE]**

### Slide 6 · Forks

No agent touches the shared code, which we call trunk, directly. Every Intent gets its own fork, a full Git repo on Cloudflare Artifacts. The only way back onto trunk is through the gate, which we'll get to in a minute.

**[NEXT SLIDE]**

### Slide 7 · The ledger

Next is the ledger. Think of it as a sign-up sheet for the code. Before Agent 1 changes verifySession, it signs up for it. The ledger also writes down that Agents 2, 3 and 4 rely on that function. So the moment Agent 1's change lands, Premise already knows exactly who might be affected.

**[NEXT SLIDE]**

### Slide 8 · Premises

A premise comes in three kinds. The first two are the types of the functions an agent read or calls, and Premise records those on its own. The third is the interesting one: a behaviour the agent says it depends on, written as a small check that can actually run. Agent 2 says: verifySession throws for an expired session. A typecheck can't see that one. Premise can.

**[NEXT SLIDE]**

### Slide 9 · When a premise breaks

So here's what happens when a premise breaks. Agent 1's change lands, and Premise reruns those checks. Two of them fail, so Agents 2 and 4 get stopped, in about half a second. Agent 3 only relied on the function's type, which didn't change, so it just keeps going. And each stopped agent is told exactly what changed, and who changed it.

**[NEXT SLIDE]**

### Slide 10 · Re-derive

What happens to the stopped work? Take Agent 2. Premise first tries a simple rebase, but Agent 2's tests fail. So the agent redoes the work on a fresh copy of the new code, and this time it knows that verifySession returns null. That's what we call re-deriving. The new version passes, and it lands. Nobody had to step in.

**[NEXT SLIDE]**

### Slide 11 · The gate

Last piece: the gate. It's the only way onto trunk, and it runs five checks. Does the code still compile? Do the agent's own tests pass? Do the reference checks pass, the ones no agent can edit? Do all the existing tests pass? And do the work's premises still hold? Only when all five are green does the work land.

**[NEXT SLIDE]**

## Part three: what it shows (slides 12 and 13)

### Slide 12 · The case tests miss

Now, why do premises matter if you already have tests? Look at Agent 4. After Agent 1's change, its own tests passed, the reference checks passed, and all ninety-one tests on trunk passed. Only its premise failed. Its tests used a fake version of verifySession that still throws. The premise checks the real thing. Tests alone would have let this through, broken.

**[NEXT SLIDE]**

### Slide 13 · Compared

We ran the same twelve tasks under three rules. With just a typecheck, three problems reached trunk. With a queue that also runs the tests, one still slipped through, the kind you just saw. With Premise, zero. To be upfront: the breaking change was planted, the agents are scripted, and Premise was the slowest of the three.

**[NEXT SLIDE]**

## Part four: how it's built, where it goes, and the demo (slides 14 to 17)

### Slide 14 · How it is built

Under the hood, it's one Worker on Cloudflare. The code lives in Artifacts, the state lives in Durable Objects, each agent runs as a Workflow, and every test runs in its own Dynamic Worker with no network. No containers anywhere.

**[NEXT SLIDE]**

### Slide 15 · Scaling up

It's a prototype, but it's already built for lots of agents: a fork per Intent, a ledger split by module, and stops that only reach the agents affected. Next, I'd want many gates instead of one, checks that only look at what a change can reach, and a UI that still makes sense when agents run for hours or days. That part is a plan, not something I've measured.

**[NEXT SLIDE]**

### Slide 16 · In a bigger system

So where would this fit in a real team? Tasks still come from people, tickets, or an orchestrator, and any kind of agent can do the work. Premise sits between those agents and trunk, and your CI and deploys carry on as before. It's one extra layer. Nothing else has to change.

**[NEXT SLIDE]**

### Slide 17 · Demo

Okay, let's see it actually run.

**[SWITCH TO THE BROWSER: the Demo tab, "Step 01 / 07"]**

This is a real run on Cloudflare, replayed. The agents are scripted, but the forks, tests and landings are all real.

**[PRESS → ONCE: "Step 02 / 07"]** Each row is one agent working on its Intent.

**[PRESS →, WAIT FOR THE TAPE TO STOP, PRESS → AGAIN: "Step 04 / 07"]** Agent 1 lands, and Agents 2 and 4 are stopped straight away.

**[PRESS →: "Step 05 / 07"]** Agent 2 redoes its work, and lands.

**[PRESS →: "Step 06 / 07"]** And here's Agent 4, the one the tests missed.

**[CLICK THE "Results" TAB]** Anyone can start a run like this from the Live tab, and every run is kept here.

**[CLICK A ROW OF THE LIVE RUNS TABLE THAT SAYS "12 of 12": A PANEL SLIDES IN FROM THE RIGHT]** Here's one of those runs, as it finished.

**[CLICK AGENT 2'S ROW IN THE PANEL]** And for any agent, you can see exactly what it changed.

**[CLICK "Close" ON THE PANEL]** That's Premise. Git tracks what agents wrote, and Premise tracks what they assumed. You can try it yourself at this address, and the code is open source on GitHub. Thanks for watching.

**[HOLD FOR FIVE SECONDS, THEN STOP THE SCREEN RECORDING. YOU END IN THE BROWSER; THERE IS NO NEED TO GO BACK TO THE SLIDES]**
