# PREMISE: the concept

> Git tracks what agents wrote. Premise tracks what they assumed, and re-derives the work the moment an assumption breaks.

Entry for Cloudflare's "Build the next Git platform" competition (deadline Oct 14, 2026, 11:59 PM PDT). Built on Workers and Artifacts.

This is the design document, written before the build and corrected since. It says what Premise is meant to be. The README says what was built and measured, and where the two differ the README is right. An "As built" note marks each place where the build went another way.

## Why the concept changed
- Prior art covers the Round 1 ideas:
  - Symbol leases: Wit, Foremerge, MCP Agent Mail, Claim Plane.
  - Reasoning storage: Entire Checkpoints, git-ai, and Cloudflare's own git-notes example.
  - Best-of-N: Cursor, Codex.
- The gap we aim at: the tools we looked at coordinate what agents **write**. Premise applies read-set validation, the check optimistic database transactions run before they commit (Kung and Robinson, 1981), to what coding agents **relied on**. The idea of validating reads is old; applying it to an agent's reading and reasoning, and redoing the work when it fails, is the part we are building. The README's "Where this comes from" lists the ancestry.
- Platform facts that shape the design:
  - Artifacts has no pre-receive hook, so enforcement happens after the push and the landing gate is the guarantee.
  - Tokens are per repo, so each intent gets its own fork.
  - There is no merge API, so the rebase is a three-way merge in the Worker. *As built:* no Sandbox and no containers. The TypeScript compiler runs inside the Worker, and tests and assertions run in Dynamic Workers.

## The single primitive: an Intent and its premises
On screen there is one object, the **Intent**, which replaces branch, PR and commit message. It contains:
- Goal.
- Acceptance checks, fixed when the intent is dispatched and immutable after that, so a re-derive cannot game them. *As built:* the names of an Intent's own tests are fixed and the agent writes their bodies. What the agent cannot touch are the task's reference checks, which live on trunk out of its reach and which the gate runs from trunk's copy.
- Two kinds of premise chips:
  - ✏️ **changes**: symbols it will write (write-premises).
  - 👁 **relies on**: symbols it depends on (read-premises), plus executable behavioural assertions.
- Its own Artifacts fork, a short-lived repo-scoped token, and `.intent/intent.json` committed in that fork.
- Agents never get a token for main.

### What a premise is (precision rules from Round 2)
- **The default hash covers a symbol's exported type surface** (its signature and types), never its function body. The gate emits `.d.ts` files before and after each landing and diffs them with the TS checker, so type changes propagate transitively.
- **Behavioural premises are executable assertions only**, for example "`verifySession` throws on an expired token".
- **The premise set is the union of three sources:**
  1. Reads observed through the API. Agents get only read, search and write tools, with no shell. Reading a whole file records every exported symbol in it.
  2. Premises derived from the diff: every symbol the changed code calls, imports or implements, resolved with tsc at each checkpoint push.
  3. Assertions the agent declares.
- **Honest wording for the video:** "Premises are the early warning. The gate is the guarantee."
- Report the false-positive rate in the A/B results.

## Mechanism
1. **Dispatch.** A Worker forks the repo with the Artifacts binding, mints a scoped token, and writes `.intent/`.
2. **Ledger.** Durable Objects sharded per module path. They hold write-premises and read-premise subscriptions. An intent that spans modules acquires them in sorted order. Expiry uses DO alarms.
3. **Overlapping write-premises** resolve through a fixed protocol: **Wait / Split / Depend**. An LLM only proposes how to split. A stalemate goes to a one-click human card. *As built:* no model is involved in the ledger's answer; Split is decided by a fixed rule, and only between exactly two Intents.
4. **After a push**, the event goes to a Queue and a checker maps the diff to symbols. *As built:* for an Intent's fork the Worker calls the checker directly, because our own code is the only thing that pushes there; the Queue carries Artifacts' own events for trunk. An edit outside the intent's write-premises quarantines the intent and requests an upgrade automatically.
5. **The gate.** A landing DO serializes landings in batches: rebase, typecheck, the Intent's tests, the task's reference checks, every test already on trunk, the premise assertions, and the checks that landed Intents left behind.
6. **Premise invalidation (core).** When something lands, each changed type surface or failed assertion turns red on every in-flight intent that relied on it, with a targeted message.
7. **Re-derive instead of rebase (the wow).** A stale intent gets a fresh fork of the new main, and its agent re-runs from the stored intent (goal, premises, rejected alternatives). *As built:* this is not a race. The plain textual rebase is tried first because it takes about a second; the agent is started only if the rebase does not pass the gate. Re-derives running at once are capped and land in priority order to avoid livelock. After 2 failures the intent goes to a human.

## The demo case (it must be behavioural)
`verifySession` keeps its signature but now returns `null` instead of throwing.
- tsc passes, so a queue that only typechecks would ship the bug.
- The textual rebase also passes tsc but fails the premise assertion.
- The re-derived version goes green.

This answers the skeptic's question, "doesn't tsc already catch it?" The next question is "don't the tests catch it?" *As built:* for two of the three dependent tasks they do, and a queue that runs tests stops them as well. The third task's tests use a stand-in for the function that changed, so they keep passing, and only its premise catches it. The A/B report compares all three landing rules.

## Proof of scale
- A real open-source TypeScript repo (about 1k exported symbols), imported into Artifacts. *As built:* a small repo written for the demo (`demo-repo/`, 35 source files, no dependencies, its own test format), published on GitHub and imported into Artifacts.
- 8 to 12 agents, each shown as a lane. *As built:* twelve, and in the recorded run and the A/B they are scripted (their turns are generated from reference solutions). Live models have been run on single tasks and on four agents at once (twice, on Cloudflare), not on all twelve. On top of that, 300 to 500 clearly labelled scripted workload agents doing real forks and pushes, shown as an aggregate counter plus ledger activity.
- **Headline A/B:** the same workload under a queue that only typechecks, a queue that also runs the tests, and Premise, measuring:
  - human merge resolutions;
  - broken builds that reached main;
  - silent behavioural regressions that reached main;
  - landings per minute;
  - premise false-positive rate.
- A live counter of forks created, with their cost.

## UI (Cloudflare Kumo, `@cloudflare/kumo`)
*As built:* none of the layout below survived. The front page is the run told as a story over a tape (one row per agent over time), with a details panel for an Intent. A second tab, Live, is the same page for the deployed Worker's board, and a third, Results, has the two panels of numbers, Compared and At scale. Kumo's `Flow` is not used, and there is no ledger rail. `docs/UI.md` has the current brief. The event log, the three premise sources, the 3-line "why" and the human's role are as written.

- **Top counters:** agents active, intents landed, broken builds on main, human merges.
- **Center:** a horizontal `Flow` with Backlog → `Flow.Parallel` lanes. Each lane is a `Flow.List`: Intent card → Check → Gate → main.
  - Collisions show through node state, `disabled`, and shared chips, because Flow has no edges between lanes.
  - Clickable content lives inside each node's `render` element, because Flow.Node has no documented onClick.
- **Right rail:** the ledger, mapping symbol → writer and readers.
- **Bottom drawer:** premises, labelled by source (observed, derived, asserted), plus a 3-line "why".
- **The human's role:** dispatch work, settle stalemates (Wait / Split / Depend), and handle the fallback when a re-derive fails twice.
- **Driven by a replayable event log** (Queue → DO → WebSocket). Every build day ends with something visible, and the stage demo on Oct 21 has a deterministic recorded fallback.

## Cut
- Arena grid.
- Companion reasoning repo.
- Vectorize.
- Ask-why chat.
- Free-form negotiation chat.
- Treemap.
- The phrase "merge queue".
- Languages other than TypeScript.
- Per-intent Workers Previews (stretch goal only).
- Jurisdiction (one line in the video).

## Video, about 8 minutes (premise break first)
*As built:* about six minutes, and a different order: the script is kept outside the repo. No dispatch, no code shot, three columns in the comparison, and a closing row on what a live model did.

- **0:00 Hook.** A/B split screen with the numbers.
- **0:30** Dispatch 12 tasks plus 300 workload agents.
- **0:45** Premise break: `verifySession` now returns null. Three intents in flight go red. tsc is green, with no text conflict.
- **1:45** Re-derive. Fresh forks go green. The textual rebase fails the assertion. A time-compression marker is shown on screen.
- **3:15** One 30-second segment covering a collision resolved by Split, a trespass being quarantined, and a stalemate card.
- **4:00** Ledger and the "relies on" drawer, showing premise sources.
- **5:00** Scale view: 300 agents, forks per second, cost.
- **6:00** 20 seconds of architecture, then the Worker code.
- **7:00** A/B results, including the false-positive rate.
- **7:30 End frame.**

## 6-day plan
- **Day 1 (Oct 8–9):** Artifacts import, fork, token and events. Ledger DO. Symbol map. Event log, WebSocket, and a Kumo shell.
- **Day 2:** Agent runner (Workflow) with API-only tools and read tracking. The UI shows live lanes.
- **Day 3:** Push checker. The gate, with type-surface diffing and assertions. Premise invalidation.
- **Day 4:** Re-derive path with caps. Workload agents. A/B harness.
- **Day 5:** UI polish. Lock in the behavioural demo case. Dry runs.
- **Day 6 (Oct 13–14):** Record the video. README, LICENSE (MIT), run instructions. Submit.
