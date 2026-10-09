# Premise: build plan

Deadline: **Wed Oct 14, 11:59 PM PDT**. Stage demo: Oct 21 (if we are a finalist).

How to use this file:
- Each session does **one task**, chosen as the first unchecked task whose dependencies are all checked.
- The full spec for each task is in `docs/tasks/<ID>-*.md`.
- Tasks in different **tracks** can run in parallel, in separate Claude Code sessions using separate git worktrees.

## Human setup (do once, before T00): marked HUMAN

H1. **Workers Paid plan.** Make sure the Cloudflare account is on Workers Paid. Artifacts requires it.

H2. **Log in to Cloudflare.** In this folder, run `npx wrangler login` and complete it in the browser. Then run `npx wrangler whoami` and note the Account ID.

H3. **LLM key.**
- Create an Anthropic API key and put it in `.dev.vars` as `ANTHROPIC_API_KEY=...` (this file is git-ignored).
- For the deployed Worker, run `npx wrangler secret put ANTHROPIC_API_KEY` after T01.
- If there is no key: agents still run with `LLM=scripted`, but the "real agents" claim gets weaker.

H4. **GitHub.** Run `gh auth status`; it should show you are logged in. Needed in T05 to publish `demo-repo` publicly, so Artifacts can `import` it.

H5. **Admin token.** Choose a random admin token. Put it in `.dev.vars` as `ADMIN_TOKEN=...`. Later, run `npx wrangler secret put ADMIN_TOKEN`.

## Schedule and task index

Tracks:
- **B** = backend core
- **U** = UI
- **D** = demo, scale and shipping

### Day 1 (Thu Oct 8 to Fri Oct 9): foundations and de-risking

- [x] **T00** (B): Spikes. Prove Artifacts fork/read/push from a Worker, TypeScript-in-Worker, and the Dynamic Worker test runner. Depends on: H1–H5
- [x] **T01** (B): Scaffold the app: Vite, React, Kumo, Worker, bindings, test setup. Depends on: T00
- [ ] **T02** (B): Shared types and event schema. Depends on: T01
- [ ] **T03** (B): RepoStore port, with a memory implementation and an Artifacts implementation. Depends on: T02
- [ ] **T04** (B/U): EventHub DO with a WebSocket, an event log and replay, plus the UI hook. Depends on: T02
- [ ] **T05** (D): Demo target repo, 12 tasks, the planted behavioural scenario, publish and import. Depends on: T01

### Day 2 (Fri Oct 9 to Sat Oct 10): symbols, premises, ledger; UI starts

- [ ] **T06** (B): Symbol index, and mapping a diff to symbols. Depends on: T02
- [ ] **T07** (B): Type-surface hashing and surface diff, using the TS program in the Worker. Depends on: T06
- [ ] **T08** (B): LedgerShard DO and the Wait/Split/Depend decision logic. Depends on: T06
- [ ] **T20** (U): App shell, counters, and Kumo Flow lanes driven by a replay fixture. Depends on: T04

### Day 3 (Sat Oct 10 to Sun Oct 11): agents, gate, invalidation

- [ ] **T09** (B): LlmClient, with an Anthropic adapter and a ScriptedLlm. Depends on: T02
- [ ] **T10** (B): IntentDO state machine and premise store. Depends on: T03, T08
- [ ] **T11** (B): Agent tools and AgentWorkflow (plan, claim, work, submit). Depends on: T09, T10, T07
- [ ] **T12** (B): Dispatch API: fork, token, `.intent/`, starting workflows. Depends on: T11, T05
- [ ] **T21** (U): Intent card, changes/relies-on chips, drawer, ledger rail. Depends on: T20

### Day 4 (Sun Oct 11 to Mon Oct 12): gate, invalidation, re-derive

- [ ] **T13** (B): Post-push checker (out-of-claim edits, derived premises). Depends on: T12
- [ ] **T14** (B): Behavioural runner (repo tests and assertions in a Dynamic Worker). Depends on: T05, T03
- [ ] **T15** (B): Landing DO, the gate (diff3 rebase, typecheck, tests, assertions, push to trunk). Depends on: T13, T14, T07
- [ ] **T16** (B): Premise invalidation, plus the trunk `pushed` event consumer. Depends on: T15
- [ ] **T17** (B): Re-derive race, with caps and escalation. Depends on: T16
- [ ] **T22** (U): Human cards (stalemate, fallback), dispatch panel. Depends on: T21, T12

### Day 5 (Mon Oct 12 to Tue Oct 13): scale, A/B, demo mode

- [ ] **T18** (D): Scripted workload agents (300 or more), rate-limited. Depends on: T15
- [ ] **T19** (D): A/B harness (baseline vs premise) and metrics. Depends on: T18, T17
- [ ] **T23** (U/D): Demo mode (record and replay), scale view, A/B panel, time-compress marker. Depends on: T19, T22

### Day 6 (Tue Oct 13 to Wed Oct 14): ship

- [ ] **T24** (D): README, LICENSE (MIT), run instructions, architecture diagram, `npm run demo`. Depends on: T23
- [ ] **T25** (D): Video script, dry-run checklist, submission checklist. Depends on: T24

**If you fall behind,** cut in this order:
1. T23's scale view
2. T18 at 300 agents (do 50 instead)
3. T22's dispatch panel (use a CLI script instead)

**Never cut:** T15, T16, T17, or the behavioural demo case.

## Model and effort per task

- Default: **Opus 5.5 at Medium effort.**
- Use **High** for **T00, T05, T07, T15 and T17**.
- If a task fails its acceptance commands twice, start a new session at High effort and redo it. Do not keep patching.

**Review checkpoints** (High effort, a fresh session, review only):
- After T05
- After T17
- After T23

Prompt for these reviews: "Review the commits since <last checkpoint> against docs/tasks and docs/SPEC.md. List deviations, bugs and missing tests, ranked by severity. Do not fix anything yet."

## Approved dependencies

- Runtime:
  - `react`
  - `react-dom`
  - `@phosphor-icons/react`
  - `@cloudflare/kumo`
  - `@fontsource/barlow-condensed`
  - `@fontsource/ibm-plex-mono`
  - `isomorphic-git`
  - `node-diff3`
  - `typescript` (yes, at runtime, inside the Worker)
- Development:
  - `vite`
  - `@vitejs/plugin-react`
  - `@cloudflare/vite-plugin`
  - `tailwindcss@4`
  - `@tailwindcss/vite`
  - `wrangler`
  - `vitest`
  - `@cloudflare/vitest-plugin` (replaces the deprecated `@cloudflare/vitest-pool-workers`; see DECISIONS, T01)
  - `@types/react`
  - `@types/react-dom`
  - `tsx` (for scripts)

## Bindings (`wrangler.jsonc`, set up in T01 and extended later)

| Binding | Kind | Notes |
|---|---|---|
| `ARTIFACTS` | artifacts | `namespace: "premise"`. Remote only. |
| `LOADER` | worker_loaders | Dynamic Workers (runs tests and assertions) |
| `HUB` | DO `EventHub` | Single instance named `"main"` |
| `INTENT` | DO `IntentDO` | One per intent id |
| `LEDGER` | DO `LedgerShard` | One per top-level module dir (`src/auth`, `src/billing`, …) |
| `LANDING` | DO `Landing` | Single instance named `"trunk"` |
| `AGENT_WORKFLOW` | workflow `AgentWorkflow` | One instance per agent run |
| `EVENTS_IN` | queue consumer `premise-events` | Artifacts event subscriptions deliver here |

Vars:
- `TRUNK_REPO="trunk"`
- `ARTIFACTS_NAMESPACE="premise"`
- `REPO_STORE="artifacts" | "memory"`
- `LLM="anthropic" | "scripted"`
- `LLM_MODEL` (default: the newest Claude Sonnet model id; check the Anthropic docs)
- `MAX_CONCURRENT_REDERIVES="3"`
- `CLOUDFLARE_ACCOUNT_ID`

Secrets:
- `ANTHROPIC_API_KEY`
- `ADMIN_TOKEN`

## Artifacts event cheat-sheet

The queue message body is the event JSON:

```jsonc
// account-level (source "artifacts"): repo.created | repo.deleted | repo.forked | repo.imported
{ "type": "cf.artifacts.repo.forked",
  "source": { "type": "artifacts", "namespace": "premise", "repoName": "trunk" },
  "payload": { "namespace": "premise", "repoName": "i-abc123", "repoId": "...", "defaultBranch": "main", ... },
  "metadata": { "accountId": "...", "eventSubscriptionId": "...", "eventSchemaVersion": 1, "eventTimestamp": "..." } }

// repo-level (source "artifacts.repo", subscribed for trunk only): pushed
{ "type": "cf.artifacts.repo.pushed",
  "source": { "type": "artifacts.repo", "namespace": "premise", "repoName": "trunk" },
  "payload": { "ref": "refs/heads/main", "before": "<sha>", "after": "<sha>",
               "commits": [{ "id": "<sha>", "message": "...", "parents": ["<sha>"] }],
               "totalCommitsCount": 1, "commitsTruncated": false },
  "metadata": { ... } }
```

## Definition of done (whole project)

- `npm run demo` against the deployed Worker shows the behavioural premise break:
  1. A `verifySession` change lands.
  2. Three in-flight intents go red.
  3. The textual rebase passes tsc but fails the assertion.
  4. The re-derive goes green and lands.
- The A/B report shows premise mode ahead of baseline on behavioural regressions reaching trunk and on human merge resolutions, with the false-positive rate shown honestly.
- The README lets a judge run it. LICENSE is MIT.
