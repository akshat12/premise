# Premise: instructions for every coding session

Read this whole file before doing anything. Then read `docs/PLAN.md` and the task file you were given.

## What we are building

**Premise** is our entry for Cloudflare's "Build the next Git platform" competition. The deadline is Oct 14 2026, 11:59 PM PDT. It is built on Cloudflare Workers and Artifacts.

> Git tracks what agents wrote. Premise tracks what they assumed, and re-derives the work the moment an assumption breaks.

- **Intent.** Each agent works on an Intent. An Intent has a goal, immutable acceptance checks, **claims** (the symbols it will change) and **premises** (the symbols it relies on, recorded as type-surface hashes, plus executable assertions). Each Intent gets its own Artifacts fork.
- **Invalidation.** When anything lands on trunk, every in-flight Intent whose premises changed goes red with a targeted message.
- **Re-derive.** A stale Intent *re-derives*: its agent re-runs on a fresh fork of the new trunk, racing a plain textual rebase. Whichever result passes the acceptance checks lands.
- **The gate.** Landing goes through a gate: typecheck, then tests, then premise assertions.

The full product spec is in `docs/SPEC.md`. If anything here conflicts with the spec, the spec wins on product questions and this file wins on engineering rules.

## Hard rules

1. **One task per session.** Task specs are in `docs/tasks/`. Do exactly the task you were given. Do not start the next one.
2. **Read before you code.** Read the task file, every file under "Read first", and the vendored docs it points to. Cloudflare's Artifacts, Workflows and Dynamic Workers APIs changed during 2026, so do not rely on memory for them.
   - Offline docs are in `docs/vendor/cloudflare/` (they are git-ignored).
   - For anything missing, fetch `https://developers.cloudflare.com/<path>/index.md`.
3. **Never invent API methods.** The complete Artifacts binding API is summarized below. If you need something that is not there, stop and say so.
4. **`src/shared/types.ts` is the single source of truth for types.** Change it only when the task says so. If you must change it anyway, note why in `docs/DECISIONS.md`.
5. **Done means every Acceptance command in the task file passes.** Paste their real output in your final message.
   - Never skip, weaken or delete a test to get green.
   - Never mock something the task says must be real.
   - If you are blocked, stop and explain what is blocking you and what you tried.
6. **When you finish:**
   - Tick the task's box in `docs/PLAN.md`.
   - Append dated notes to `docs/DECISIONS.md`: surprises, deviations, anything the next session must know.
   - Commit with the message `Txx: <title>`.
7. **Steps marked HUMAN.** Stop and ask the user to run them. Give exact copy-paste commands. Never ask the user to paste secrets into chat. Secrets go in `.dev.vars` (local) or `wrangler secret put` (deployed).
8. **Vocabulary for all UI copy, docs and the video script:**
   - Use: **Intent**, **changes** (✏️ chips), **relies on** (👁 chips), **premise**, **re-derive**, **gate**, **trunk**.
   - Negotiation outcomes are exactly **Wait / Split / Depend**.
   - Never use "merge queue", "pull request", "PR" or "branch" in UI copy.
9. **Code standards.**
   - TypeScript strict everywhere. No `any` unless it is commented.
   - Small pure functions for logic, so they can be unit-tested without Cloudflare.
   - Durable Objects and Workflows are thin shells that call pure logic.
10. **Dependencies.** Only the ones listed under "Approved dependencies" in `docs/PLAN.md`. Adding another requires a note in `DECISIONS.md` explaining why.
11. **No containers and no Docker.** We do not use Cloudflare Containers or the Sandbox SDK. Code execution uses Dynamic Workers (the Worker Loader). Typechecking uses the TypeScript compiler API inside the Worker.
12. **UI work follows `docs/UI.md`.** Light mode only (forced). Intents are drawn as flight strips. There is one orchestrated animation, the premise break. Before you finish any UI task, take a screenshot and do the self-critique pass. If a UI task file and `docs/UI.md` disagree on visual details, `docs/UI.md` wins.

## Commands (after T01)

```
npm run dev         # vite + wrangler dev (local)
npm run dev:local   # the same with no Cloudflare login: wrangler.local.jsonc, memory repos, scripted agents
npm run demo        # resets, dispatches the 12 tasks plus a workload, opens the live board (--replay plays /?demo=main)
npm test            # vitest (unit + workers pool)
npm run typecheck   # tsc --noEmit for worker + ui
npm run deploy      # build + wrangler deploy
npm run smoke       # hits the DEPLOYED worker to exercise real Artifacts (needs ADMIN_TOKEN)
```

## Verified platform facts (checked Oct 8 2026, wrangler 4.149.0)

### Artifacts binding

Config in `wrangler.jsonc`:

```jsonc
"artifacts": [{ "binding": "ARTIFACTS", "namespace": "premise" }]
```

- A namespace is created automatically the first time you create a repo in it.
- **The binding is REMOTE-ONLY, even in `wrangler dev`.** It needs Cloudflare auth and network access. This is why all repo access goes through the `RepoStore` port, with an in-memory fake for tests.
- Run `npx wrangler types` to generate the `Artifacts` types into `worker-configuration.d.ts`.

Namespace methods (`env.ARTIFACTS`):

| Method | Notes |
|---|---|
| `create(name, opts?)` | Returns `{ name, remote, defaultBranch, token }` |
| `get(name)` | Returns a disposable repo handle. Use `using repo = await env.ARTIFACTS.get(name)`. Throws if missing or not ready. |
| `list({limit?, cursor?})` | Each repo has a `status` of `ready`, `importing` or `forking` |
| `import({ source: { url, branch?, depth? }, target: { name, opts? } })` | `source.url` must be HTTPS |
| `delete(name)` | |

Repo handle methods:

| Method | Notes |
|---|---|
| `info()` | |
| `createToken(scope = "write", ttlSeconds?)` | Returns `{ plaintext, expiresAt }` |
| `listTokens()` | |
| `revokeToken(tokenOrId)` | |
| `fork(name, { description?, readOnly?, defaultBranchOnly? })` | Returns `{ name, remote, defaultBranch, token }` |
| `log({ ref = "HEAD", limit ≤ 1000, offset })` | Newest first |
| `readCommit(sha)` | |
| `readTree(treeSha)` | Immediate children only |
| `readBlob(sha)` | |
| `readFile({ ref, path })` | Returns `Blob \| null` |

The binding **cannot write files**. To write, use git: isomorphic-git in the Worker with an in-memory fs (see `docs/vendor/cloudflare/artifacts/examples/isomorphic-git.mdx`).

### Git over HTTPS

- Remote format: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
- Token format: `art_v1_<40hex>?expires=<unix>`.
- With isomorphic-git, use `onAuth: () => ({ username: "x", password: token.split("?expires=")[0] })`.
- Push uses protocol v1 receive-pack only.

### Limits

- 2,000 control-plane requests per 10 s per namespace.
- 2,000 git requests per 10 s per repo.
- 1 GB per repo.
- 32 MB per file.
- Repo names start with a letter or digit. After that, only `[A-Za-z0-9._-]` is allowed.

### Events (Queues event subscriptions)

- **Account-level** (`--source artifacts`): `repo.created`, `repo.deleted`, `repo.forked`, `repo.imported`.
- **Repo-level** (`--source artifacts.repo --source-namespace <ns> --source-repo-name <repo>`): `pushed`, `cloned`, `fetched`, `token.created`, `token.revoked`.
- **Push events exist only per repo.** We subscribe `pushed` on **trunk only**. For Intent forks, our own code is the only thing that pushes, so we emit our own events at that point.
- The `pushed` payload contains `ref`, `before`, `after`, `commits[]`.
- Full JSON examples: `docs/vendor/cloudflare/queues/event-subscriptions/` and the summary at the bottom of `docs/PLAN.md`.

### What runs where

- **Local `wrangler dev` works for:** Durable Objects (SQLite), the Worker Loader (Dynamic Workers), and Workflows. This was verified for DOs and the Loader.
- **Remote only:** Artifacts and LLM calls.

### Dynamic Workers (Worker Loader)

- Binding: `"worker_loaders": [{ "binding": "LOADER" }]`.
- Usage: `env.LOADER.load({ compatibilityDate, mainModule, modules: { "path.js": "source" }, globalOutbound: null, limits: { cpuMs } }).getEntrypoint("Name").method()`.
- Use it to run repo tests and premise assertions in isolation.

### TypeScript compiler in a Worker

- Bundles to about 1.7 MB gzip, which fits the Workers Paid 10 MB limit.
- It needs `"define": { "__filename": "\"/typescript.js\"", "__dirname": "\"/\"" }` in the Wrangler or Vite config.
- Runtime is NOT yet verified. Task T00 verifies it.

### Kumo UI

- Package: `@cloudflare/kumo` (v2.14.x).
- Peer dependencies: `react`, `react-dom`, `@phosphor-icons/react`.
- Tailwind v4 CSS must start with:
  - `@source "../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";`
  - `@import "@cloudflare/kumo/styles/tailwind";`
  - `@import "tailwindcss";`
- Wrap the app root in `className="isolate"`.

### Kumo `Flow`

- Parts: `Flow` (`orientation`, `align`), `Flow.Node` (`render`, `disabled`), `Flow.Parallel`, `Flow.List`, `Flow.Anchor`.
- It has NO `onClick`, NO edge labels, NO edges across lanes, and NO animation.
- Clickable content goes inside the element you pass as `render`.
- Show collisions with node state and chips, not with edges.

### Plan

The Workers **Paid** plan is required for Artifacts.

## Architecture map (see `docs/PLAN.md` for detail)

```
src/shared/            types.ts, events.ts   (shared by worker + ui)
src/worker/index.ts    fetch router + queue consumer + exports of DO/Workflow classes
src/worker/ports/      repo-store.ts (interface), artifacts-repo-store.ts, memory-repo-store.ts, llm.ts (interface + adapters)
src/worker/symbols/    symbol index + diff→symbols (TS compiler API parser)
src/worker/surface/    type-surface hashing + diff (TS program, in-memory host)
src/worker/runner/     Dynamic Worker test/assertion runner
src/worker/ledger/     LedgerShard DO + pure decision logic (Wait/Split/Depend)
src/worker/intent/     IntentDO + pure state machine
src/worker/agent/      AgentWorkflow + tools
src/worker/gate/       Landing DO (gate) + rebase (diff3) + invalidation
src/worker/hub/        EventHub DO (event log + WebSocket broadcast + replay)
src/worker/workload/   scripted workload agents
src/worker/ab/         A/B harness (baseline vs premise)
src/ui/                React + Kumo app
demo-repo/             the target TypeScript repo the agents work on (pushed to GitHub, imported into Artifacts as "trunk")
scripts/               smoke, seed, replay recording
```

## Testing strategy

- **Pure logic** (symbols, surface, ledger decisions, state machine, diff3, metrics): plain vitest.
- **Durable Objects, Workflows and the Loader**: `@cloudflare/vitest-pool-workers`, or `wrangler dev` plus curl.
- **Artifacts**: only through `RepoStore`.
  - Tests use `MemoryRepoStore`.
  - Real Artifacts is exercised by `npm run smoke` against the deployed Worker.
  - Set `REPO_STORE=memory` in `.dev.vars` to run the whole app locally without Cloudflare.
- **LLM**: only through `LlmClient`.
  - Tests and demo replays use `ScriptedLlm`.
  - Set `LLM=scripted` to run locally without keys.
