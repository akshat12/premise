# Decisions log

Append dated entries. Newest at the bottom. Each entry says what changed, why, and what the next session must know.

## 2026-10-08: Pre-build findings (planning session)

- **No containers.**
  - Code execution uses Dynamic Workers (the Worker Loader).
  - Typecheck and type-surface use the TypeScript compiler API inside the Worker.
  - Reason: Sandbox SDK 1.0 changed its API, and containers need Docker at deploy time.
- **The Artifacts binding is remote-only, even in `wrangler dev`.**
  - Hence the `RepoStore` port with a memory fake.
  - `REPO_STORE=memory` gives fully local dev.
- **Artifacts push events are repo-level only.**
  - Subscribe `pushed` on trunk only.
  - For fork pushes, our code emits its own events.
- **TypeScript in a Worker bundles to about 1.7 MB gzip.**
  - It needs `define` for `__filename` and `__dirname`.
  - Runtime is not yet verified; T00 verifies it.
- **Verified locally:** a Durable Object and the Worker Loader both work under `wrangler dev` (wrangler 4.149.0).
- **Premise surface hash** = the exported declaration text from `.d.ts` emit, with comments removed. It never includes function bodies.
- **Behavioural premises** exist only as executable assertions.

## 2026-10-08: T00 results

All three spikes pass, locally (`wrangler dev`) and deployed. Code is in `spikes/` (throwaway). Versions: wrangler 4.149.0, typescript 5.9.3, isomorphic-git 1.43.2.

**1. Artifacts create / fork / read / push from a Worker: works.**

- **A shallow-clone push to a fork works** (`singleBranch: true, depth: 1`, then commit, then push `main`). A full clone works too. No fallback was needed.
- After the push, `log({ limit: 5 })` on the fork returns 2 commits (the fork's new commit, then the base commit), and `readFile` returns the pushed text.
- `fork()` resolves only when the fork is usable: `get()` on the new fork succeeded on the first try every time (0 retries in 7 runs). The spike keeps a retry loop anyway.
- Timings in ms. The repo is tiny (2 files, 1 commit), so these are floor values, and shallow vs full clone cannot be told apart at this size.

| Step | Deployed (3 runs) | Local dev, remote binding (4 runs) |
|---|---|---|
| `create()` | 1375–2007 | 1538–2684 |
| first push to base | 362–663 | 461–797 |
| `fork()` | **2598–3134** | 2477–3326 |
| `get()` on the new fork | 20–44 | 393–822 |
| `readFile()` | 68–103 | 104–214 |
| clone, `depth: 1` | 264–343 | 375–747 |
| clone, full | 366 | 468 |
| push to fork | 339–421 | 336–1276 |
| `log()` | 19–27 | 29–61 |

- **`fork()` takes about 3 s and `create()` about 1.5–2 s.** These are the slow steps. T12 and T18 must fork concurrently, not one after another, or 300 agents will take 15 minutes just to fork.
- `ArtifactsCommitMetadata` fields: `hash`, `treeHash`, `message`, `author`, `committer`, `parents`, `authoredAt`, `committedAt` (unix seconds).

**2. TypeScript compiler API in a Worker: works** (typescript 5.9.3, no downgrade needed).

- Emits `.d.ts` for both in-memory files with `diagnostics: []`, using `lib.es2022` (57 lib files loaded).
- **ts emit: 47–139 ms** in local dev (first call 102–139, warm 47–59).
- Loader run and ts emit cannot be timed inside a deployed Worker: `Date.now()` does not advance during synchronous CPU work in production, so `/ts` reports `ms: 0` there. From the client, deployed `/ts` took 0.53–1.43 s wall time including TLS and cold start. **Any metric we show for CPU-bound work (T19, T23) must be measured across an I/O boundary or it will read 0.**
- Workarounds:
  - `define` for `__filename` and `__dirname` is set as the task specified. I did not test whether it is still required without it.
  - **Lib loading:** used the generator script, not Wrangler `Text` rules. `spikes/scripts/gen-libs.mjs` writes `src/ts-libs.generated.ts` (57 files, 485 KB raw) exporting a `Record<fileName, text>`. It skips `*.full.d.ts`, which pull in the DOM libs.
  - **The compiler API wants lib file names, not tsconfig short names:** `lib: ["lib.es2022.d.ts"]`, with `getDefaultLibLocation: () => "/lib"` and the host serving `/lib/<fileName>`.
  - Also set `types: []` so the program does not look for `@types`.

**3. Dynamic Worker test runner: works. No import rewriting needed.**

- `/loader` returns `[{"name":"adds","ok":true}]`.
- **Relative imports resolve between path-like module names.** Modules were keyed `runner.js`, `src/math.js`, `tests/math.test.js`. `runner.js` imports `./tests/math.test.js`, which imports `../src/math.js`. T14 can use repo-relative paths as module names with `.ts` swapped for `.js`; source imports must already use the `.js` extension.
- **Loader run: 2–3 ms** in local dev, 14–23 ms deployed (deployed is measurable because the RPC call is I/O). Transpiling both modules with `ts.transpileModule`: 1–17 ms locally.
- The main module needs only the named `WorkerEntrypoint` class export; no default export.

**Bundle size** (from `wrangler deploy`): `Total Upload: 11790.25 KiB / gzip: 1887.90 KiB`, Worker startup time 83 ms. That is TypeScript, isomorphic-git and the lib strings together.

**Surprises and deviations the next session must know:**

- **The docs' MemoryFS helper does not work with isomorphic-git 1.43.2 as copied.** `git.init` throws `Cannot read properties of undefined (reading 'bind')`. Two gaps:
  1. isomorphic-git requires `readlink` and `symlink` on `fs.promises`.
  2. It branches on Node-style `err.code` (`ENOENT`, `EEXIST`, `ENOTDIR`); the helper only puts the code in the message. It also expects a single-level `mkdir` that throws `EEXIST`.
  - `spikes/src/memory-fs.ts` is the verbatim copy. `spikes/src/git-fs.ts` is a 60-line adapter that fixes both. **T03 should start from the adapter**, not from the docs helper.
- `/loader` returns exactly the results array as its body, to match the acceptance check. Its timings are in an `x-timings` response header instead of the JSON body.
- `/artifacts` deletes its two repos in a `finally` block (`?keep=1` skips this; `?depth=full` does a full clone). A `/cleanup` route deletes any repo named `spike-*`.
- `wrangler dev` shows the Artifacts binding as `remote` with no extra config, and prints a warning that goes away with `"remote": true` on the binding.
- `wrangler types` asks for `@types/node` because of `nodejs_compat`. Not installed in the spike; T01 should add it.
- Generated files `spikes/worker-configuration.d.ts` and `spikes/src/ts-libs.generated.ts` are git-ignored. `npm run typecheck` in `spikes/` regenerates both.

**Left behind in the Cloudflare account:**

- The Worker `premise-spikes` was deleted on 2026-10-08 after the spikes passed (`npx wrangler delete --name premise-spikes`). Its routes had no auth, so redeploy it only for a short test and delete it again.
- The Artifacts namespace `premise-spike` exists and is empty (checked with `wrangler artifacts repos list`).

**Human setup still open:** there is no `.dev.vars` yet, so H3 (`ANTHROPIC_API_KEY`) and H5 (`ADMIN_TOKEN`) are not done. T00 did not need them. H1, H2 and H4 are done.

## 2026-10-09: LLM choice (Workers AI is the fallback, not implemented)

**Decision.** The plan is unchanged: T09 builds `AnthropicLlm` and `ScriptedLlm` behind the `LlmClient` port, and live model use is kept small by recording real runs once and replaying them (`RecordingLlm`, T23). Workers AI is **not** implemented. It is the ready fallback if there is no Anthropic key when T12 needs a live run, or if the key becomes a problem.

**Open point.** There is still no `ANTHROPIC_API_KEY` (H3). The first task that needs a real model is T12; T23 needs one to record the demo run. Whoever reaches T12 without a key should stop and ask whether to add the key or switch to the fallback below.

**The fallback, as tested on 2026-10-09** (a scratch probe Worker under `wrangler dev`, not kept in the repo):

- **Model: `@cf/openai/gpt-oss-120b`.** 128,000-token context, function calling, not paid-gated (so 300 requests per minute, not 20).
- **No API key.** Add `"ai": { "binding": "AI" }` to `wrangler.jsonc` and call `env.AI.run(model, { messages, tools, max_completion_tokens })`. The binding is remote even in `wrangler dev`, like Artifacts. The current wrangler login already has the `ai (write)` scope.
- **Request and response are OpenAI chat-completions shaped**, not Anthropic shaped, so it needs its own adapter (`WorkersAiLlm`) behind `LlmClient`:
  - Tools: `{ type: "function", function: { name, description, parameters } }`. `ToolDef.input_schema` maps to `parameters`.
  - Reply: `choices[0].message.tool_calls[]`, each `{ id, type: "function", function: { name, arguments } }` where `arguments` is a JSON **string**. `finish_reason` is `"tool_calls"` or `"stop"`. Usage is `usage.prompt_tokens` and `usage.completion_tokens`.
  - Tool results go back as `{ role: "tool", tool_call_id, content }`. The assistant turn must be echoed back with its `tool_calls`.
  - A model may return several tool calls in one turn.
- **Test.** A cut-down agent loop (list, read, assert premise, declare changes, write, submit) on the `t02` audit-log task, then typecheck plus the acceptance check on the result:

| Model | Correct runs | Time per run | Neurons per run |
|---|---|---|---|
| `gpt-oss-120b` | 3 of 3 | 16–35 s | 310–470 |
| `gemma-4-26b-a4b-it` | 3 of 3 | 50–90 s | 170–310 |
| `glm-4.7-flash` | 1 of 3 | 20–31 s | 105–135 |

  - One run each also passed for `qwen3.8-27b` (104 s), `nemotron-3-120b-a12b`, `mistral-small-3.1-24b-instruct` and `gpt-oss-20b`.
  - One run each failed for `qwen3-30b-a3b-fp8`, `llama-4-scout-17b-16e-instruct`, `llama-3.3-70b-instruct-fp8-fast` and `granite-4.0-h-micro`.
- **Known weaknesses of `gpt-oss-120b`:**
  - It skipped `assert_premise` in 2 of 3 runs. The prompt must push this, or steer it to adopt the pre-written assertion.
  - In every run it produced one or two text-only turns ("Implemented ...") before calling `submit`. The loop must answer a turn with no tool call by asking for one, not by ending.
- **Cost.** The free allocation is 10,000 Neurons per day (resets 00:00 UTC), then $0.011 per 1,000. `gpt-oss-120b` is 31,818 Neurons per M input tokens and 68,182 per M output. Real agent runs will be larger than the probe (my estimate: 5 to 10 times), so a full 12-agent demo run will not fit in one day's free allocation; expect well under a dollar per run.
- **Limits of this test.** One small task, three files, and no `run_checks` feedback. Paid-gated models (`glm-5.3-flash`, `kimi-k2.7-code`, `deepseek-v4-*`) were not tested.

**Second fallback: AI Gateway Unified Billing.** Prepaid Cloudflare credits (5% fee, provider prices passed through) let the same `env.AI.run()` call reach Claude, GPT or Gemini with a gateway id as the third argument and no provider key. Not tested.

## 2026-10-09: T01 notes (scaffold)

- **Dependency change: `@cloudflare/vitest-plugin` replaces `@cloudflare/vitest-pool-workers`.**
  - The approved package is deprecated: its README says it was renamed and will get no updates, and its last release pins vitest 4.1 and wrangler 4.124.
  - `@cloudflare/vitest-plugin@1.4.0` supports vitest 5. `PLAN.md`'s approved list is updated.
  - What changes for later tasks:
    - Config is the `cloudflareTest({ wrangler: { configPath } })` Vite plugin in `vitest.config.ts`, not a `poolOptions` block.
    - **There is no `SELF`.** Use `import { exports } from "cloudflare:workers"` and call `exports.default.fetch(url)`. Task specs that say `SELF.fetch` mean this.
    - `env` comes from `cloudflare:workers` too. `cloudflare:test` still has the Durable Object and Workflow helpers.
    - Types come from `"@cloudflare/vitest-plugin/types"` in `tsconfig.worker.json`.
- **Versions installed:** vite 8.3, vitest 5.0, @cloudflare/vite-plugin 1.63, wrangler 4.149, react 19.3, @cloudflare/kumo 2.14, tailwindcss 4.3, typescript 5.9.
- **Env types.**
  - `npm run types` runs `wrangler types --strict-vars false`. Without the flag every var is a literal type (`LLM: "scripted"`), and `env.LLM === "anthropic"` would not compile.
  - Secrets (`ADMIN_TOKEN`, `ANTHROPIC_API_KEY`) are declared as optional in `src/worker/env.ts` by merging into the global `Env`. I did not use Wrangler's `secrets.required`, to avoid coupling deploys to secrets that are not set yet.
- **Vars in `wrangler.jsonc` are the deployed defaults:** `REPO_STORE="artifacts"`, `LLM="scripted"` (there is no Anthropic key yet; T12 switches this), `LLM_MODEL="claude-sonnet-5-5"` (T09 must confirm the id). `.dev.vars` overrides them locally.
- **`wrangler.test.jsonc`** is `wrangler.jsonc` minus the `artifacts` binding and the `assets` block, with `REPO_STORE="memory"`. Keep the two files in step when bindings change.
- **Asset routing.** `assets.run_worker_first: ["/api/*"]` is set. Without it a browser navigating to an `/api/` URL gets `index.html`, because of the single-page-application fallback.
- **Artifacts binding in dev.** It is marked `"remote": true`, which removes the warning seen in T00. `npm run dev` starts with it present when logged in to Wrangler ("Establishing remote connection..."). The Vite plugin's `cloudflare({ remoteBindings: false })` option turns remote bindings off if someone needs to run without auth. Not tested logged out.
- **The `__filename`/`__dirname` define** is in both `vite.config.ts` and the "workers" project of `vitest.config.ts`. Nothing imports `typescript` in the app yet, so it is unproven under Vite; T06 or T07 will be the first real test.
- **Not typechecked:** `vite.config.ts`, `vitest.config.ts` and `scripts/` are outside both tsconfig projects, because they need `@types/node`, which is not an approved dependency. `tsx` and Vite still run them.
- **Queue `premise-events` created** with `wrangler queues create` (I was already authenticated).
- **Deployed:** `https://premise.akshatdivekar.workers.dev`. `/api/health` returns `{"ok":true,"store":"artifacts","llm":"scripted"}`.
- **`.dev.vars` exists locally** with only `REPO_STORE=memory` and `LLM=scripted`. `ADMIN_TOKEN` (H5) is still not set; T04's admin routes will need it.
- `.claude/launch.json` holds the dev-server launch config for the Claude desktop preview.

## 2026-10-09: T02 notes (shared types)

- `src/shared/types.ts` and `src/shared/events.ts` are copied from the task file unchanged (extracted with a script, not retyped).
- `src/shared/ids.ts` choices the spec left open:
  - `moduleShard` returns `"."` for a file at the repo root (`"root.ts#x"`), and the top directory alone for a file one level down (`"tests/a.test.ts#t"` gives `"tests"`).
  - `symbolId` throws if either part is empty or contains `#`, so every id it builds can be parsed back.
  - `newIntentId` uses rejection sampling, so the 8 characters are uniform over base36.
- The "workers" test project loads `.dev.vars` ("Using secrets defined in .dev.vars"). A local `.dev.vars` with `REPO_STORE=artifacts` would change what those tests see. Keep `.dev.vars` on `memory` and `scripted`, or set bindings explicitly in the test.
- `src/ui/index.css` uses `../../node_modules/...` in its `@source` line, not the `../node_modules/...` shown in `CLAUDE.md`, because the path is relative to the CSS file and ours is two levels down.

## 2026-10-09: T03 notes (RepoStore)

**Status: code complete; one acceptance step is waiting on the human.** The contract passes 8 of 8 against `MemoryRepoStore` (unit tests) and 8 of 8 against real Artifacts through `npm run dev` (remote binding). The **deployed** `npm run smoke` has not run, because the Worker has no `ADMIN_TOKEN` secret yet (H5). The T03 box in `PLAN.md` stays unticked until it does.

- **Empty repos: `ZERO_SHA`.** A repo with no commits has head `"0" * 40` (exported as `ZERO_SHA` from `ports/repo-store.ts`). Pass it as `expectedHead` to make the first commit, and as `from` in `changedPaths` to mean "everything". `readFile` at `ZERO_SHA` returns null.
- **Interface additions** beyond the task file: `ZERO_SHA`, `MAX_SNAPSHOT_FILE_BYTES`, `DEFAULT_AUTHOR`, `isCommitSha`. The `RepoStore` method signatures are unchanged. `listFiles` and `changedPaths` return sorted paths.
- **Bug class to avoid: `using` plus an un-awaited return.** `using repo = await env.ARTIFACTS.get(name)` releases the handle when the function returns. `return somePromise` (without `await`) then fails later with "RPC stub used after being disposed". Always `return await` inside a function that holds a `using` handle. Unit tests cannot catch this; only the real binding does.
- **Artifacts errors have no `.code` through the remote binding in local dev.** `create()` on an existing repo threw a plain `Error` with message `"ArtifactsError: repo already exists: <name>"` and no `code`. `isArtifactsError` checks the code when there is one and falls back to the message. The message patterns for "fork/create/import in progress" are a guess; the codes are from the generated types.
- **Writes.** `commit` mints a 600-second write token, shallow-clones (`depth: 1`, `singleBranch`), checks the cloned head against `expectedHead`, applies the changes, commits and pushes. The first commit on an empty repo uses `git.init` instead of a clone. Tokens are left to expire, not revoked. A failed push re-reads the head and throws `StaleHeadError` if it moved.
- **Reads.** `readFile` and `head` use the binding directly. `listFiles`, `snapshot` and `changedPaths` walk trees with at most 16 reads in flight. `changedPaths` skips subtrees whose hash is unchanged. `snapshot` drops files over 1 MB and files that are not valid UTF-8.
- **`fork` uses `defaultBranchOnly: true`.**
- **Filesystem for isomorphic-git:** `ports/memory-fs.ts` (the docs helper, verbatim) plus `ports/git-fs.ts` (the adapter from T00), both copied from `spikes/`.
- **`MemoryRepoStore`.** `getMemoryStore()` is a module-level singleton: its state is per isolate and is lost on reload. That is fine for `REPO_STORE=memory` local dev and never used when deployed. `resetMemoryStore(seed?)` exists for tests. Refs it understands: `main`, `HEAD`, `refs/heads/main`, or a commit sha.
- **The contract** (`ports/repo-store.contract.ts`) has no vitest dependency, so the Worker can run it. `contractCases` is the list; `runContract(makeStore, { prefix, parallel, cases })` runs them and removes the repos it made.
- **`POST /api/admin/smoke`** (header `x-admin-token`) runs the contract against `ArtifactsRepoStore` whatever `REPO_STORE` is, in parallel, then deletes any leftover `smoke-*` repos. It took 16 to 19 s locally. Admin routes fail closed: with no `ADMIN_TOKEN` configured, every request gets 401.
- **`scripts/smoke.ts`** reads the token from the `ADMIN_TOKEN` environment variable, or from `.dev.vars` if that is unset, so it never has to be typed on a command line.
- **Real-Artifacts timings seen in the contract run:** a case that creates one repo and makes two commits takes 6 to 8 s; the fork case takes 12 to 14 s.

## 2026-10-09: T04 notes (EventHub)

- **Wire protocol** is in `src/shared/wire.ts` (used by Worker and UI). A socket frame is one of:
  - a bare event object,
  - `{ "backlog": [...] }`, sent on connect. A long log is sent as several backlog frames of up to 2,000 events each,
  - `{ "reset": true }`, sent to every client when the log is cleared. **This frame is an addition to the task file.** Without it a client would keep its old events and resume from a `seq` that no longer exists.
- **`reset()` restarts `seq` at 1** (it also clears `sqlite_sequence`).
- **Ping.** The hub registers `setWebSocketAutoResponse("ping" -> "pong")`, so keep-alives do not wake a hibernated object. `webSocketMessage` also answers `ping`, as the task asks.
- **`hub(env)` returns a hand-written `HubApi` interface**, not the generated stub type. The generated type maps `publishMany` and `since` to `never`, because the event union contains `Record<string, unknown>` (the `artifacts` event's `detail`) and the Workers RPC type helpers reject it. Call the hub only through `hub/publish.ts`.
- **Routes.** `routes/events.ts` serves `GET /api/events` and `GET /api/events/ws` with no auth (read-only). `routes/admin.ts` serves `POST /api/admin/events/reset` and `/fake`; `/fake` rejects a body whose `t` is not a known event type.
- **Workers tests now run in one shared worker** (`maxWorkers: 1, isolate: false` in the "workers" project). The vitest plugin does not support WebSockets to Durable Objects with per-file storage isolation. Consequences for later tasks:
  - Storage is **not** rolled back between test files. Give each test its own Durable Object name (see `freshHub()` in `hub.workers.test.ts`).
  - The two projects need different `sequence.groupOrder` values or vitest refuses to start.
- **UI.**
  - `src/ui/lib/reduce.ts` is the only state logic. `IntentView` adds `lastNote`, `decision`, `outOfClaim`, `gate`, `race` and `human` to `IntentSummary`. The ledger in `ViewState` holds in-flight Intents only: an Intent leaves it when it lands or fails. `human.resolved` sets `human.resolved` on the card data; a card is open while `human && !human.resolved`.
  - `src/ui/lib/stream.ts` has the pure parts of the hook (backoff, de-duplication, replay timing). Replay skips the gaps on both sides of a `demo.marker`.
  - The hook itself is not unit-tested (no DOM test library is approved). It was checked in the browser: backlog, live events and reset all arrive.
  - `App.tsx` shows a one-line stream status for now. T20 replaces it.
- **Fixture.** `src/ui/fixtures/sample-run.json` has 116 events, not "about 60": it tells the whole story and uses every event type. It is generated by `scripts/make-sample-run.mjs`; edit the script and re-run it rather than editing the JSON. `reduce.test.ts` checks the story it tells.
- **Task ids and symbols fixed by the fixture, which T05 must match:**
  - `t01-null-expired` changes `src/auth/session.ts#verifySession`.
  - Three Intents assert "verifySession throws" and go red: `t02-audit-expired` (`src/auth/login.ts#handleLogin`), `t03-expired-metrics` (`src/api/handlers.ts#authenticate`), `t11-expired-rate-limit` (`src/auth/rate-limit.ts#guardRequest`).
  - `t04-session-ttl-header` (`src/api/responses.ts#withSessionHeaders`) relies on `verifySession` by type only and stays green.
  - The rest: `t05-tax-rounding`, `t06-discount-stacking`, `t07-role-check`, `t08-profile-validation`, `t09-currency-format`, `t10-invoice-numbering`, `t12-password-policy`. `t05` and `t06` both want `src/billing/invoice.ts#computeTotal`.
- **Three red Intents, not two.** `SPEC.md`, the definition of done in `PLAN.md` and this task all say three premises break. `T05-demo-repo.md` plants only two (`t02`, `t03`). The fixture follows the spec, so T05 turns the "rate-limit window" task into `t11-expired-rate-limit`, a third task that relies on the throw.

## 2026-10-09: T05 notes (demo repo)

**Status: code complete; two acceptance steps are waiting on the human.** Everything local passes. Still to do: publish `demo-repo/` to a public GitHub repo (the user must confirm the name), then call `POST /api/admin/import-trunk` on the deployed Worker (needs `ADMIN_TOKEN`, H5), then create the two event subscriptions. The T05 box in `PLAN.md` stays unticked until then.

**The repo.** `demo-repo/` is "acme-accounts": 35 source files, 317 exported symbols (the target was 200 to 300), 9 test files with 90 tests, no dependencies, no Node or DOM APIs, clocks and ids injected everywhere.

- Imports use `.js` extensions (`from "./session.js"`), because the Dynamic Worker resolves module names literally (T00).
- `tsconfig.json` has `lib: ["es2022"]` and `types: []`, so `console` and `process` do not exist for the compiler. `premise/run-tests.ts` declares the two it needs and loads `node:fs` through a variable specifier, so the whole repo typechecks without Node's types.
- `premise/hidden-tests/` is excluded from `tsconfig.json`: those tests describe behaviour, and in one case an export (`canAccess`), that does not exist on trunk yet. **The gate's typecheck (T15) must leave that directory out too.**
- `tests/support.ts` has shared builders (`makeUser`, `makeSession`, `makeInvoice`, `makeDeps`, `T0`, `now`). Acceptance tests may use it.

**The planted scenario.**

- `verifySession` (in `src/auth/session.ts`) throws `SessionExpiredError` on an expired session. Three callers catch it, each in a different file so the Intents do not collide:
  - `src/auth/login.ts#handleLogin` (task `t02-audit-expired`)
  - `src/api/handlers.ts#authenticate` (task `t03-expired-metrics`)
  - `src/auth/rate-limit.ts#guardRequest` (task `t11-expired-rate-limit`)
- `t01-null-expired` makes it return null instead. It touches only `session.ts`, so nothing conflicts textually and `tsc` stays green.
- **The planted gap is deliberate: no test on trunk covers an expired session going through `verifySession` or any of the three callers.** If such a test is ever added, `t01` will fail the gate and the demo breaks. `sessionTtl` and `isExpired` are tested, which is fine.
- After `t01`, callers can no longer tell "expired" from "never signed in" from the return value alone. The re-derived solutions look the token up in the store and use `isExpired`. Each of the three tasks has an acceptance check that anonymous and unknown tokens are *not* treated as expired, so a re-derive cannot pass by handling every null as expired.
- `t04-session-ttl-header` is the control: it reads `session.ts` but uses only the `Session` type and `sessionTtl`, so it passes before and after `t01`.
- **Three Intents go red, not two.** The task file plants two (`t02`, `t03`). `SPEC.md`, `PLAN.md` and T04 all say three, so the "rate-limit window" task became `t11-expired-rate-limit`. That leaves seven ordinary tasks instead of eight.
- The collision pair: `t05-tax-rounding` needs `taxFor` and `computeTotal`; `t06-discount-stacking` needs only `applyDiscounts` but its hint points at `computeTotal`, which is what invites the Split.

**Reference solutions and how they are built.**

- `demo-solutions/solutions.ts` holds each solution as find-and-replace edits on trunk files; `demo-solutions/tests/` holds each task's acceptance tests. `npm run demo:reference` generates `demo-repo/premise/reference/<id>.patch.ts` (15 patches, each a `FileChanges` object as its default export, plus `meta`) and `demo-repo/premise/hidden-tests/<task>.test.ts` (12 files). Do not edit the generated files.
- Patches exist for every task, plus `t02-rederived`, `t03-rederived` and `t11-rederived`, which are written against trunk after `t01`.
- The generator fails if an edit's `find` text does not match exactly once, so the solutions cannot drift from the repo silently.

**`npx tsx scripts/check-scenario.ts`** (also `npm run demo:check`) builds patched copies of the repo in a temp directory and checks 39 outcomes: the four the task asks for, for all three relying tasks; the `t04` control; the assertion `a-session-throws` holding on trunk and breaking after `t01`; and every ordinary task's solution passing without breaking any other test. For an expected failure it prints the reason, e.g. `expected {"error":"session_expired"}, got {"error":"unauthorized"}`.

- It evaluates an assertion's `code` with `new Function`, spreading the imported modules into scope. That works in Node. **Dynamic Workers do not allow `new Function`, so T14 needs another way**, such as generating a module whose imports name each export (the symbol index from T06 has the names).

**Memory mode.** `src/worker/ports/demo-seed.ts` bundles `demo-repo/**/*.{ts,json,md}` with `import.meta.glob(..., { query: "?raw", eager: true })`. This works in the Worker build, in `vite dev` and in both vitest projects. `getRepoStore(env)` seeds `env.TRUNK_REPO` from it the first time the memory store is created. `"vite/client"` was added to the Worker tsconfig's `types` for `import.meta.glob`.

**`POST /api/admin/import-trunk`** imports `DEMO_REPO_URL` (a new var, currently `https://github.com/akshat12/acme-accounts.git`, a guess until the user confirms the name) into Artifacts as `TRUNK_REPO`, polls `list()` until the repo is `ready`, and returns its head and file count. Body options: `{ "url": "...", "replace": true }`. With an existing trunk and no `replace` it returns 409. In memory mode it just reports the bundled trunk.

**Publishing.** `scripts/publish-demo-repo.sh <owner>/<name>` exports `demo-repo/` to a temp directory and publishes from there. This replaces the task's `cd demo-repo && git init`, which would have put a git repo inside this one. Re-running it later adds a commit with whatever changed.

**Tests.** The "workers" vitest project now sets `ADMIN_TOKEN`, `REPO_STORE` and `LLM` through the plugin's `miniflare.bindings`, so admin routes can be tested and the results no longer depend on `.dev.vars`.

## 2026-10-09: Google AI Studio free tier (looked at, not tested)

A third LLM option, after the Anthropic key and the Workers AI fallback. Nothing is implemented and no key exists.

- **There is a free tier** for the Flash and Flash-Lite models (`gemini-3.8-flash`, `gemini-3.5-flash-lite` and others) and for `gemini-2.5-pro`. `gemini-3.1-pro-preview` has none. Source: Google's pricing page, updated 2026-10-09.
- **The daily request cap is the constraint, and I could not confirm it.** Google no longer publishes free-tier numbers in its docs; they are shown per project at `aistudio.google.com/rate-limit`, which needs a login. A post on Google's developer forum (2026-09-03) reports 20 requests per day for `gemini-3.8-flash` and 500 for Flash-Lite. An older article (May 2026) says about 15 per minute and 1,500 per day for Flash. Limits are per project and reset at midnight Pacific.
- **What Premise needs:** one agent run is roughly 8 to 32 model requests, so a 12-agent demo run with re-derives is roughly 150 to 450 requests, with up to 12 agents calling at once.
- **Integration:** it needs an API key (a `GEMINI_API_KEY` secret). It has an OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`, `Authorization: Bearer <key>`) that accepts `tools`, so it could share the chat-completions adapter the Workers AI fallback would need. AI Gateway also proxies it. For Gemini 3 models the model's thought and function-call parts must be sent back unchanged on the next turn; whether the OpenAI-compatible endpoint handles that across tool results is not documented and was not tested.
- **Data:** content sent on the free tier is used to improve Google's products. The demo repo is public, so that is acceptable here.

## 2026-10-09: T06 notes (symbol index)

- `src/worker/symbols/index.ts` uses the TypeScript parser only. It is the first app code that imports `typescript`; it runs in the Node unit tests, and T07 adds the first test inside workerd.
- **Extra exports beyond the task's API:** `resolveImport(fromPath, specifier)` and `isIndexedPath(path)` (true for `*.ts` outside `tests/` and `premise/`, not `.d.ts`).
- **`signatureEndLine` for consts:** a const whose value is an arrow function or function expression with a block body is treated like a function, so editing its body is a body touch. Every other const is all interface, as the task says.
- **`lineDiff` treats lines that differ only in whitespace as equal** and drops changes made only of blank lines. That is how `touchedSymbols` ignores reformatting.
- **Private helpers:** a changed non-exported declaration gives a body touch on every export that mentions its name, following helper-to-helper chains. The check is a name match on the export's source lines, not scope-aware.
- **`importMap` has no entry for `import * as ns`.** `referencedSymbols` resolves `ns.name` and `ns.Type` uses to `<path>#name` itself. It skips identifiers that are declaration names or property names, and does not model shadowing.
- **Re-exports from another module** (`export { x } from "./y.js"`, `export * as ns from ...`) are not symbols of the re-exporting file. `demo-repo/src/index.ts` is all re-exports, so it contributes only `VERSION`.
- The demo-repo test reads the repo through `DEMO_REPO_FILES` (Vite's `import.meta.glob`) rather than `node:fs`, because the Worker tsconfig has no Node types.
- On the demo repo, the planted `t01` edit is reported as a **body** touch on `verifySession` and nothing else.

## 2026-10-09: T03 closed, admin token set

- **H5 is done.** At the user's request I generated a random `ADMIN_TOKEN`, saved it in `.dev.vars` (git-ignored) and set the same value as the deployed Worker's secret with `wrangler secret put`. The value was never printed.
- **T03's last acceptance step passed:** `npm run smoke` against the deployed Worker ran the RepoStore contract on real Artifacts, 8 of 8, in about 10 s (the same run took 16 to 19 s through local dev).
- **Public demo repo:** the user is creating `akshat12/acme-accounts` themselves and asked that nothing pushed there mention the competition. `demo-repo/` never did; its README no longer names Cloudflare either, and `scripts/publish-demo-repo.sh` now pushes to an existing (even empty) repo and uses neutral commit messages and description.

## 2026-10-09: T05 closed (published and imported)

- **Published:** `https://github.com/akshat12/acme-accounts` (public), created with `scripts/publish-demo-repo.sh akshat12/acme-accounts` after the user said to go ahead. Its commit message, description and README do not mention the competition or Cloudflare.
- **Imported:** `POST /api/admin/import-trunk` on the deployed Worker returned `{"ok":true,"store":"artifacts","repo":"trunk","status":"ready","head":"5dff7900…","files":81,"ms":3416}`. `wrangler artifacts repos list --namespace premise` shows `trunk` as `ready`.
- **To republish after changing `demo-repo/`:** run the publish script again, then call import-trunk with `{"replace": true}`. Replacing trunk deletes and re-creates the repo, so the trunk push subscription below may need re-creating afterwards (not tested).
- **Still open, HUMAN:** the two event subscriptions. T16 needs them; nothing before T16 does.
  ```
  npx wrangler queues subscription create premise-events --source artifacts --events repo.created,repo.forked,repo.imported,repo.deleted --name premise-account
  npx wrangler queues subscription create premise-events --source artifacts.repo --events pushed --source-namespace premise --source-repo-name trunk --name premise-trunk-push
  ```

## 2026-10-09: T07 notes (type surface)

- **Import the compiler from `src/worker/ts`, never from `"typescript"` directly.** On load, the compiler decides whether it is in Node by checking `process.nextTick`, `require` and `!process.browser`. Under `nodejs_compat` a Worker passes, and the compiler then builds its Node "system" object, which calls `os.platform()`, `fs` and `__filename`. In the vitest workers pool that crashed workerd outright ("Worker exited unexpectedly"), and after pre-bundling it failed with `_os.platform is not a function`. The wrapper sets `process.browser = true` for the instant the compiler module loads and then restores it, so `ts.sys` is `undefined` everywhere (Node tests included) and nothing touches `os`, `fs` or `__filename`. We always pass an in-memory host, so nothing is lost.
  - The `__filename`/`__dirname` `define` from T00 is therefore no longer needed. It is still in `vite.config.ts` and `vitest.config.ts` and is harmless.
  - The workers vitest project also has `deps.optimizer.ssr.include: ["typescript"]`; without pre-bundling, loading the 9 MB compiler module by module crashes the runtime.
- **Verified in the deployed Worker on the real Artifacts trunk** with the new route `POST /api/admin/analyze`: 81 files, 317 symbols, no type errors, 2.5 to 4.6 s per request including the Artifacts snapshot. Deployed bundle: 9008 KiB, 1665 KiB gzip, startup 39 ms.
- **Libs.** `surface/libs.ts` bundles the es2022 lib files with `import.meta.glob` straight from `node_modules/typescript/lib`, so there is no generated file and no `scripts/gen-ts-libs.ts`. They always match the installed compiler.
- **API additions:** `analyze(files)` returns typecheck and surface from one program (use it when you need both); `fnv1a64`; and each surface entry has `refs` (the exported symbols its declaration mentions) next to `hash` and `decl`.
- **`hash` covers the symbol's own declaration only.** Transitive changes are found by `diffSurface` following `refs`: a symbol is `changed` if its own hash differs or it mentions a symbol that changed, was added or was removed. A stored `Premise.surfaceHash` therefore does not change when only a dependency changes; rely on `diffSurface`, not on comparing stored hashes.
- Private (non-exported) declarations have no id; their text is folded into the `decl` of each export that mentions them.
- Root files are every `*.ts` outside `tests/` and `premise/` (`isIndexedPath` from T06), which for the demo repo is `src/**`. Test files are never typechecked here.
- **The planted scenario holds at the type level:** applying `t01` gives an empty `diffSurface`, and `t01` plus `t02` still typechecks.
- `src/worker/testing/demo.ts` gives tests `demoFiles()`, `referencePatch(id)` and `demoWith(...ids)`.
- Timing: `analyze` on the demo repo takes about 0.6 s in Node and in local workerd. In a deployed Worker `ms` reads 0, as found in T00.

## 2026-10-09: T08 notes (ledger)

- **`ClaimRequest` has one extra optional field, `elsewhere`:** the number of symbols the same request claims in other shards. A shard sees only its own symbols, and the Split rule needs to know whether the requester wants anything besides the contested ones. `requestClaimsAcrossShards` fills it in.
- **The shard does not filter by shard.** The client sends each shard only that shard's claims. (A Durable Object cannot reliably read its own name, so it cannot check.)
- **Depend** applies when *every* contested symbol is held as `interface` and wanted as `body`, or when the requester already lists the other Intent in `dependsOn`. A mixed overlap falls through to Split or Wait.
- **Split when the requester has higher priority moves the contested symbols**: the shard deletes the holder's rows for them and gives them to the requester. With equal priority the holder keeps them, because the requester's `since` is "now". In the demo all agent Intents should have equal priority unless T12 decides otherwise, so the holder keeps `computeTotal`.
- **Split is the one non-granted decision that leaves claims behind**: the requester keeps its `mine` part, in this shard and in shards that already granted. Wait and Depend release everything.
- **Stalemate** is tracked per shard in a `history` table (non-granted decisions, and landings). `release(intentId, landed)` takes a second argument so a landing resets the count. `isStalemateAcrossShards(env, a, b, shards)` is the call for T11.
- **Expiry:** claims last 10 minutes (`CLAIM_TTL_MS`). Expired rows are dropped at the start of every request and snapshot as well as by the alarm, so correctness does not depend on the alarm firing. The alarm publishes nothing.
- **Extra client functions:** `subscribeAcrossShards`, `renewEverywhere`, `isStalemateAcrossShards`, `groupByShard`, `shardsOf`, `ledgerShard`. Like the hub, the shard is used through a hand-written `LedgerApi` interface.
- Workers tests use a unique fake directory per test (`t<time>x<n>/billing/...`), because storage is shared across the workers test run.

## 2026-10-09: T09 notes (LLM client, provider-neutral)

The user asked that the architecture make it easy to switch to another model provider (Google, OpenAI or something else). T09 is built that way.

- **One port, three adapters.** `ports/llm.ts` holds the `LlmClient` interface, the provider table and `getLlm`. Adapters: `llm-anthropic.ts` (Messages API over `fetch`), `llm-openai.ts` (any OpenAI-compatible chat-completions endpoint), `llm-scripted.ts` (`ScriptedLlm`, `RecordingLlm`). `llm-http.ts` has the shared POST-with-retries.
- **Switching provider is configuration only.** Set `LLM` to a row of `PROVIDERS` and supply a key:

  | `LLM` | Wire format | Key (first found) | Default model |
  |---|---|---|---|
  | `scripted` | none | none | none |
  | `anthropic` | Anthropic | `LLM_API_KEY`, `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
  | `openai` | OpenAI-compatible | `LLM_API_KEY`, `OPENAI_API_KEY` | none, set `LLM_MODEL` |
  | `google` | OpenAI-compatible | `LLM_API_KEY`, `GEMINI_API_KEY` | `gemini-3.8-flash` |
  | `openrouter` | OpenAI-compatible | `LLM_API_KEY`, `OPENROUTER_API_KEY` | none |
  | `groq` | OpenAI-compatible | `LLM_API_KEY`, `GROQ_API_KEY` | none |
  | `workers-ai` | OpenAI-compatible (REST) | `LLM_API_KEY`, `CLOUDFLARE_API_TOKEN` | `@cf/openai/gpt-oss-120b` |
  | `openai-compatible` | OpenAI-compatible | `LLM_API_KEY` | none; needs `LLM_BASE_URL` |

  Optional: `LLM_MODEL`, `LLM_BASE_URL` (a gateway or proxy), `LLM_MAX_TOKENS` (default 16,000), `LLM_EFFORT`. A new provider with one of the two wire formats is one row; a new wire format is one more adapter.
- **Nothing has been called for real.** There is no key for any provider. Every adapter test uses a fake `fetch`. Two live tests exist and are skipped unless `ANTHROPIC_API_KEY` or `LIVE_LLM=<provider>` (plus that provider's key) is in the environment. The first live call may show a request-shape problem that the mocked tests cannot.
- **Workers AI is reachable as a preset** through its OpenAI-compatible REST endpoint with a Cloudflare API token. The keyless `env.AI` binding adapter is still not written, as the user asked; `toChatMessages`, `toChatTools` and `fromChatCompletion` are pure so that adapter would be about twenty lines.
- **Additions to the interface in the task file** (all optional fields, so scripts and callers that ignore them still work):
  - `raw` on assistant messages and on `LlmTurn`: the provider's own form of the turn, replayed verbatim. Use `assistantMessage(turn)` to build the message to append.
  - `inputError` on `tool_use` blocks: set when the model's arguments could not be parsed. The agent loop must answer with an `is_error` result, not run the tool.
  - `stop` can also be `"refusal"`.
- **Why `raw` exists, and a rule T11 must follow.** Current Claude models think by default and return `thinking` blocks that must be sent back unchanged. Their signature also covers the system prompt, the tool list and every earlier message; on Anthropic accounts created since 2026-08-31, a request whose history was edited is rejected with a 400. Gemini has a similar requirement (thought signatures on tool calls). So, **within one conversation: keep `system` and `tools` identical on every call and only ever append to `messages`.** In particular the plan and work phases must not use different system prompts or tool lists inside one conversation. T11 will use one prompt and one tool list for the whole run, enforce phases in the tool handlers, and announce the phase change in a tool result. This is also what makes prompt caching work.
- **Anthropic adapter details.**
  - `max_tokens` defaults to 16,000, not the task's 4,096: thinking counts against it, and 4,096 can cut off a whole-file write.
  - Top-level `cache_control: { type: "ephemeral" }` is sent (automatic prompt caching), because every turn resends the conversation. Turn it off with the `cache: false` option if it causes trouble.
  - `output_config.effort` is sent only when `LLM_EFFORT` is set. Anthropic's guidance for Claude Sonnet 5.5 is to start agentic tool use at `medium`.
  - `tool_choice` is never sent: forcing a tool returns a 400 on Sonnet 5.5.
  - Server-side refusal fallbacks (`fallbacks: "default"`, a beta header) are **not** enabled, because a wrong beta header fails every request and it cannot be tried without a key. A refusal comes back as `stop: "refusal"`.
  - Usage adds cached input tokens to `input`.
- **OpenAI-compatible adapter details.** Sends `max_completion_tokens`. Tool results become one `role: "tool"` message each; an error result is prefixed `ERROR: `. Only `role`, `content` and `tool_calls` are replayed from the provider's message, since servers differ on which other fields they accept back.
- **Retries:** 408, 409, 429 and 5xx (including Anthropic's 529), and network errors, up to three times, waiting the server's `retry-after` if given (capped at 30 s) or else 1, 2, 4 s with jitter.
- `RecordingLlm` drops `raw` from what it records, since scripts never go back to a provider.
- `LLM_MODEL` stays `claude-sonnet-5-5` in `wrangler.jsonc`. If `LLM` is switched and `LLM_MODEL` is left as a Claude id, the provider's default model is used, or the error says to set `LLM_MODEL`.

## 2026-10-09: T10 notes (IntentDO)

- **Errors cross the Durable Object boundary as values.** A method that throws inside a Durable Object reaches the caller as a plain `Error` (the class is lost), and under the vitest plugin the same rejection is also reported as an unhandled error, which fails the run even when the test expected it. So `IntentDO` exposes one RPC method, `rpc(method, args)`, which returns `{ ok, value }` or `{ ok: false, error }` (`src/worker/rpc.ts`). `intentStub(env, id)` builds the client and re-throws failures with their class: an illegal status change arrives as a real `IllegalTransition` with `from` and `action`. **Use the same pattern (`capture`, `rpcClient`) for any later Durable Object whose methods can fail in expected ways**, such as the Landing gate.
  - `rpc()` only dispatches names listed in `INTENT_METHODS`; a compile-time check keeps that list equal to `IntentApi`.
- **Storage** is two SQLite tables: `state` (the Intent as JSON under one key) and `overlay` (one row per path, `content` NULL for a deletion), so a large overlay is not one big value.
- **Machine.** `fail` is allowed from every status except `landed` and `failed`. A premise break turns the Intent stale from `working`, `submitted`, `checking`, `queued`, `gating` or `rederiving` (`CAN_GO_STALE`); in any other status the premise is marked broken and the status is left alone. `IN_FLIGHT` and `TERMINAL` are exported for T16.
- **Premises.**
  - Identity is `(symbol, source)`, plus the assertion id for asserted premises. Observed, derived and asserted premises on one symbol are kept side by side, so a read never replaces an assertion.
  - `breakPremise(symbol, by, scope?)` takes an optional third argument: `{ assertionId }` or `{ sources: [...] }`. **T16 should pass `{ assertionId }` for an assertion failure and `{ sources: ["observed", "derived"] }` for a surface change.** Without it every holding premise on the symbol breaks, which would wrongly mark the type-level premise red in the planted scenario.
  - It returns `{ broken, intent }`, and is a no-op if nothing matched or the premise was already broken.
  - Only premises with a surface hash are subscribed in the ledger, as the task says.
- **Additions to the task's method list:** `recordPremises` (batch), `setDependsOn`, `clearOverlay`, and `restartOn(repo, baseCommit)` for T17 (new fork, no head, empty overlay, assertions kept and reset to holding, everything read cleared). `readOverlay` returns a string, `null` for a staged deletion, or `undefined` for an untouched path.
- `act` records `headCommit` on `submit` and `land`, and releases the Intent's ledger rows on `landed` and `failed`.
- `newIntent(fields)` in `intent/client.ts` builds a record in its starting state (`repo` defaults to the id).

## 2026-10-09: T14 notes (behavioural runner), done before T11 because `run_checks` uses it

- **Verified in the deployed Worker** through `POST /api/admin/analyze`, which now also runs trunk's `tests/session.test.ts` (8 pass) and `a-session-throws` (holds) in a Dynamic Worker: 3.7 to 6.4 s per request including the Artifacts snapshot and the typecheck.
- **Local workerd does not enforce `limits.cpuMs`.** An infinite loop in a Dynamic Worker hangs the whole local process, the parent included, so a wall-clock `Promise.race` never fires. The runner therefore **rewrites every loop** while transpiling: each loop body starts with `__premiseTick()`, which throws once one item has gone round more than 5,000,000 times ("possible infinite loop"). This works the same locally and deployed; `cpuMs` (default 5,000) is still set as a second line of defence in production.
- **A syntax error in any module stops the whole Dynamic Worker from starting**, including modules nobody imports. Link errors, top-level throws and missing modules, by contrast, fail only the `import()` that hits them. So:
  - The entry module imports nothing statically. Each test file and assertion module is loaded with `import()` when its item runs, so one bad module fails only its own items.
  - Syntax is checked while transpiling. A broken file under `src/` is a `loadError` (nothing can run). A broken test file or assertion fails only its own items and is left out of the load.
  - The transpiler misses some things JavaScript rejects, such as a redeclared `const` or an `import` inside a function. If the Worker fails to start, the runner reads the module name out of the error, fails that module's items, drops the module and tries again (up to 10 times). If the error names a `src/` module or nothing we loaded, everything fails with a `loadError`.
- **Module names** follow T00: the repo path with `.js`. Relative specifiers are normalised to end in `.js` after transpiling, so `./x`, `./x.ts` and `./x.js` all work.
- **What gets loaded:** every `*.ts` outside `tests/` and `premise/`, `premise/assert.ts`, each requested test file, and whatever those test files import (found with `ts.preProcessFile`, which is how `tests/support.ts` comes along). Nothing else under `premise/` is loaded.
- **Assertions.** The module for an assertion imports `assert` and each of its `imports`, and destructures every runtime export of those modules into scope; the names come from the symbol index (T06), since `new Function` is not available in Workers. The code is the body of an async function and may use TypeScript syntax and `await`. Import paths are forgiving: `./`, a leading `/`, a missing extension, `.js`, and a `#symbol` suffix are all accepted.
- **Limits per item:** the loop budget above, and 5 s wall clock for an item that awaits something that never settles. The whole run has a 20 s wall-clock limit.
- **A fresh isolate per run** (`LOADER.load`, not `LOADER.get`). Reusing an isolate would let module-level state leak from one run into the next. Transpiled output is cached in memory by content hash instead, which is where the time goes.
- `RunResult.loadError` is also set when the run as a whole fails after loading (timeout, CPU limit): every item is then failed with that message.
- Extra exports: `planRun` (modules, runnable items and per-item failures), `transpile`, `normalizeSpecifiers`, `assertionSource`, `normalizeImportPath`, `startFailureModule`, `moduleKey`.
- The planted scenario reproduces in the isolate: on `t01` plus `t02`, the acceptance test fails with `expected {"error":"session_expired"}, got {"error":"unauthorized"}`, and `a-session-throws` fails with "expected the function to throw SessionExpiredError, but it returned".

## 2026-10-09: T11 notes (agent tools and workflow)

- **One conversation, one system prompt, one tool list.** The task file describes separate `PLAN_PROMPT` and `WORK_PROMPT` and different tools per phase. That would change the system prompt and tool list inside one conversation, which current Claude models reject on new accounts (see the T09 notes) and which defeats prompt caching on every provider. Instead:
  - `SYSTEM_PROMPT` covers both phases. All nine tools are always offered.
  - Phases are enforced by the handlers: `write_file`, `run_checks` and `submit` return an error in the plan phase; `declare_changes` returns one in the work phase.
  - The phase change is announced in the result of the `declare_changes` call ("Granted. ... You are now in the work phase").
  - The history is only ever appended to.
- **The logic is in `agent/run.ts` (`runAgent`), not in the Workflow class.** `runAgent(deps, params, steps)` takes a small `Steps` interface (`do`, `waitForEvent`). `AgentWorkflow` in `agent/workflow.ts` adapts real Workflow steps to it; tests pass in-memory steps (`memorySteps()` in `testing/agent.ts`). The end-to-end tests call `runAgent` directly in the workers pool; the real Workflow is first exercised in T12.
- **Step names:** `load`, `plan-turn-<n>`, `claim-<round>`, `accept-split-<round>`, `work-turn-<n>`, `push`, `record-push`, `hand-off`, plus `wait-ledger-<round>`, `ask-human-<round>` and `human-choice-<round>` when the ledger says no. Each turn step makes the model call and runs the tools it asked for; it returns only that turn's messages, and the driver rebuilds the conversation from step results.
- **`declare_changes` and the ledger.** The handler stores the claims, `why` and rejected alternatives and signals the driver. The driver asks the ledger in a `claim-<round>` step and supplies the tool result itself.
  - Granted: carry on.
  - Split: the Intent's claims are cut down to the ledger's `mine` list and the agent is told which symbols the other Intent keeps.
  - Split for the second time between the same pair (a stalemate): `human.needed` is published with options Wait / Split / Depend, and the run waits for a `human-choice` event.
  - Wait or Depend: status `waiting`, then `waitForEvent("ledger-free", 30 minutes)`, then ask again. After 6 rounds the Intent fails.
  - **Nothing sends `ledger-free` yet.** T12 or T15 must send it to waiting Intents' workflow instances when an Intent lands or fails, or a waiting agent sits for the full 30 minutes.
- **Re-derive mode** (`params.mode === "rederive"`): the same driver, but it makes no status changes (the Intent stays `rederiving`), records the push with `setHead`, and the briefing gains the block describing what broke, the earlier `why`, and the rejected alternatives.
- **A run stops quietly if the Intent is no longer its own.** Each turn first checks the status; if a premise broke and the Intent went `stale` mid-work, the run returns `stopped` and pushes nothing.
- **Tool details.**
  - `read_file`, `search_symbols` and `read_symbol` record observed premises with the symbol's surface hash at the Intent's base commit. A file is recorded once per run. Files the agent created, and test files, record nothing.
  - Hidden from every tool: `premise/` (except `premise/assert.ts`, which tests import), `.intent/`, `tests/hidden*`. `premise/` and `tests/` symbols cannot be claimed.
  - `assert_premise` runs the assertion immediately and refuses it if it does not hold: a premise has to be true when recorded. It accepts an optional `symbol`; otherwise the symbol is the first function from its imports that the code calls.
  - `run_checks` typechecks base plus overlay, then runs the Intent's acceptance tests and its holding assertions in the runner.
  - **`submit` runs the same checks and refuses if they fail**, so nothing that fails its own checks is ever pushed.
  - Tool results are capped at 60,000 characters; `write_file` at 200,000.
- **Turn limits:** 12 plan turns, 20 work turns. A turn with no tool call gets "Continue by calling a tool." A refusal fails the Intent.
- **The push step is safe to retry:** if the fork's head is no longer the expected one, an earlier attempt already pushed, and that head is used.
- **`premisesForRederive` changed from the T10 note:** broken assertions are now dropped, not reset to holding. A kept "verifySession throws" would fail the gate for the re-derived work, which has to rely on the new behaviour.
- **Recorded agent runs for every task.** `npm run agent:scripts` generates `src/worker/agent/__scripts__/<taskId>.json` for all 12 tasks, and `<taskId>.rederive.json` for `t02`, `t03` and `t11`, from the reference solutions. Each plays: read the files it changes (the three relying tasks and `t04` also read `session.ts`), adopt `a-session-throws` if it relies on the throw, declare, write, check, submit. Claims are computed with `touchedSymbols`. The `t06` script also claims `computeTotal`, which produces the Split with `t05`. With `LLM=scripted` the whole pipeline therefore runs with no model key. Regenerate after `npm run demo:reference`.
  - In a scripted run the client is rebuilt each turn from the number of assistant messages so far, so a restarted Workflow replays from the right place.
- `agent/handoff.ts` is the seam for what follows a push. For now it moves a submitted Intent to `checking` then `queued`; T13 and T15 extend it.
- Tests that use real symbol names end by failing their Intent, because the ledger is shared across the test run.

## 2026-10-09: T12 notes (dispatch)

**Status: code complete; the live check with a real model is waiting on a model key.** `npm test -- dispatch` and typecheck pass. The task's last acceptance step is a deployed dispatch with `LLM=anthropic`, and there is no key yet. In its place I ran the same dispatch on the deployed Worker with `LLM=scripted`: real Artifacts forks, real Workflows, recorded agents. Both Intents (`t04`, `t05`) went `planning` to `queued` in about 20 seconds, with 2 forks and 2 pushes counted. **The T12 box stays unticked until the dispatch has been run with a real model.** Later tasks build on T12's code regardless, at the user's request to keep going until a key is needed.

- **Real Workflows run in the workers test pool.** `introspectWorkflow(env.AGENT_WORKFLOW)` from `cloudflare:test` gives the instances a route created; `waitForStatus("complete")` and `getOutput()` work. Only one introspection session per Workflow binding can be open at a time. The test run prints "RPC result was not disposed" and "Worker's code had hung" lines from finished instances; they do not fail anything.
- **The EventHub now also holds** (all filled in as events pass through `publish`):
  - `registry`: every Intent with its latest status (`GET /api/intents`).
  - `shards`: the ledger shards that hold claims or readers (`GET /api/ledger` merges their snapshots).
  - the counters behind the metrics.
  - the name of the repo acting as trunk.
  - `waiters`: paused Workflow instances and what each waits for.
- **Read the trunk name with `currentTrunk(env)`, never `env.TRUNK_REPO`.** A demo reset makes a fresh copy under a new name (`trunk-<time>`) and points the hub at it. `import-trunk` points it back at `TRUNK_REPO`.
- **Metrics** (`src/worker/metrics.ts`): `countEvent` is a pure reducer over events (forks and pushes from `artifacts` events of type `forked` and `pushed`, broken premises, re-derives, and one `humanMerges` per `human.needed`); `agentsActive` and `intentsLanded` come from the registry. `publishMetrics(env)` publishes the current numbers; dispatch and reset call it. `hub.bump(counter)` exists for the A/B harness. Also `GET /api/metrics` and `GET /api/trunk`.
  - **Dispatch publishes its own `artifacts` event of type `forked`**, because the queue subscriptions are not set up and memory mode has no platform events. T16's queue consumer must use a different type for the platform's own fork events, or forks will be counted twice.
- **Waking waiting agents.** Before pausing, a run records `ledger:<intent it waits on>` or `human:<its own id>` in the hub. `IntentDO.act` wakes the ledger waiters of an Intent when it lands or fails (`agent/wake.ts`); `POST /api/human/:id` wakes the human waiter with the choice and publishes `human.resolved`. Because a wake-up can be missed if the other Intent finishes first, a waiting agent also re-asks the ledger every 30 seconds (`LEDGER_WAIT`), up to 40 rounds (`MAX_CLAIM_ROUNDS`), instead of the task's single 30-minute wait.
- **Priority.** `priorityOrder` in the dispatch body gives the first task priority 1, the next 2, and so on; tasks it does not mention come after. With no order, every task has priority 5, so the holder keeps contested symbols.
- **`RepoStore` gained `list()`** (names of all repos, sorted), with a contract case. Reset uses it to find Intent forks (`i` plus 8 base36 characters, optionally `-r<n>`).
- **`POST /api/admin/reset-demo`** deletes the Intent forks, imports (or in memory mode, seeds) a fresh trunk under a new name, clears the ledger shards, then clears the event log, registry, counters and waiters. On the deployed Worker it took 5.3 s and left `trunk` (the original import) alongside `trunk-<time>`; earlier reset copies are deleted, the original `trunk` is not. Workflows still running for deleted forks are not terminated; they fail on their own.
- `POST /api/dispatch` and `POST /api/human/:id` both require the admin token. There is no separate `run-one` route: dispatching one task does the same thing.
- The smoke test now has 9 contract cases and passes on the deployed Worker.

## 2026-10-09: T13 notes (post-push checker)

- `src/worker/gate/checker.ts`: `checkPush` (pure), `runChecker` and `settleQuarantine`. `agent/handoff.ts` now calls `runChecker`; it is what the agent's `hand-off` step runs.
- **Derived premises look at whole symbols, not only changed lines.** For an edited source file the search covers the changed lines plus the full range of every exported symbol the edit touched. The `t02` patch adds one line inside a `catch` block; on changed lines alone the checker would miss `verifySession` and `SessionExpiredError`, which the function plainly depends on. New files and edited test files are searched too (a new test shows what the Intent leans on). Only source symbols become premises; test helpers and `premise/` have no type surface.
- A derived premise is skipped when the Intent already has an observed premise on the same symbol. Base surfaces are cached in memory per base commit (8 entries).
- **Quarantine and upgrade.** An out-of-claim edit moves the Intent to `quarantined` and asks the ledger for the missing claims at the strength the push used.
  - Granted: claims are merged, status goes to `queued`, and the Intent is handed to the gate.
  - Not granted: the Intent stays `quarantined`, `human.needed` (kind `stalemate`, options Wait / Split / Depend) is published, and a waiter is recorded so the checker looks again when the holder lands or fails.
- **What the three choices do for a quarantined Intent** (`POST /api/human/:id` calls `settleQuarantine` when the status is `quarantined`; for an escalated Intent it still wakes the paused agent run):
  - **Split:** the contested symbols are given to this Intent, the one that actually edited them, whoever holds them (`forceClaimsAcrossShards`, a new ledger operation used only here). It then goes to `queued`.
  - **Wait:** ask again now; if still refused, stay quarantined until the holder finishes.
  - **Depend:** as Wait, and the holder is added to `dependsOn`.
- **Waiters can now be quarantined Intents as well as Workflow instances.** A waiter id starting with `checker:` is re-checked through `settleQuarantine(..., "retry")` instead of being sent a Workflow event. `agent/handoff.ts` registers that handler when it loads.
- **A re-derived Intent** (status `rederiving`) is checked the same way but is never quarantined and keeps its status; it is handed to the gate with path `"rederive"`.
- **The gate hook is `CheckerDeps.enqueue(intent, path)`.** Nothing is passed yet, so a checked Intent stops at `queued`. T15 supplies it.
- `runChecker` and `settleQuarantine` take an optional `store`, so tests can use their own `MemoryRepoStore`.
- Event order for a clean run is now: ... `artifacts` (pushed), `intent.status` (submitted, checking), `push.checked`, `premise.recorded` (derived, if any), `intent.status` (queued).

## 2026-10-09: T15 notes (the gate)

- **Files.** `gate/rebase.ts` (`threeWayRebase`, pure), `gate/gate.ts` (`gateOne` with injected `GateDeps`), `gate/queue.ts` (`taskPriority`, `pickBatch`, pure), `gate/landing.ts` (`gateDeps`, `landIntent`, and the `Landing` Durable Object), `gate/client.ts` (`landing(env)`, `gateEnqueue(env)`), `gate/invalidate.ts` (the stub T16 fills in; its `Landed` argument and `Invalidate` type are already what T16's spec asks for).
- **The gate is wired in.** `handOff` (the agent's last step), the checker's wake-up for quarantined Intents, and `POST /api/human/:id` all pass `gateEnqueue(env)` as the checker's `enqueue`. An Intent that passes the checker now goes on to `gating` and then `landed`, `stale` or `failed`; nothing stops at `queued` any more. Tests that pass their own checker `deps` (a private store) still get no gate, by design: `handOff`'s default is the real gate only when no `deps` are given.
- **Verified on the deployed Worker with real Artifacts** (scripted agents, fresh trunk): `t01` landed in 4.8 s, `t02` was stopped by the gate with `textConflict: false`, typecheck ok and the acceptance test failing with `expected {"error":"session_expired"}, got {"error":"unauthorized"}`, and `t04` landed in 2.5 s. That is the demo's central moment, end to end.
- **Rebase rules** beyond the task's table: a change trunk already has (same edit, or both deleted) is not a conflict; both sides adding the same path with different content is; an Intent edit to a file trunk deleted is. A conflicted path keeps trunk's content in `files`. `.intent/` paths from the Intent are ignored. Lines are split on `\n`, so a missing final newline survives. `excludeFalseConflicts` is on.
- **`GateDeps` has one extra, optional field, `trunk`** (the repo name, default `"trunk"`), because `snapshot` and `head` take a repo name and trunk's name changes on a demo reset. `gateOne` also returns `conflicts` (paths) and `trunkBefore` next to the three fields in the task file.
- **Reading a `GateReport`.** A step that did not run reports nothing passed: on a text conflict `typecheck` is `{ ok: false, errors: [] }` and the test lists are empty; on a type error the test lists are empty. Read it top-down and stop at the first failure. `tests.passed` and `tests.failed[].name` are test names (`AcceptanceCheck.testName`).
- **All asserted premises are run at the gate, holding or not**, as the task says. For a re-derive that is right because `restartOn` already dropped the broken ones.
- **Acceptance tests are files the agent adds** (`tests/<name>.test.ts`), so they arrive with the Intent's own changes and are run from the rebased files. `describeFailure(report, conflicts)` gives the one-line note for the status change (assertion failures are named before test failures).
- **A landing that changes nothing** (the work is already on trunk) is reported `ok` with `landedCommit` equal to the current head, makes no commit, and publishes no `trunk.advanced`.
- **`StaleHeadError`:** the whole check runs once more against the new trunk; a second one is thrown to the caller.
- **The Landing object is driven by an alarm, not `waitUntil`.** `enqueue` inserts a row and sets an alarm for now; `alarm()` gates one batch (up to 5, sequentially) and sets itself again while rows remain. An alarm survives eviction and never overlaps itself. `busy` is in memory only and is for `status()`.
  - Queue row: `intent_id` (primary key), `path`, `priority`, `enqueued_at`, `attempts`. Enqueueing an Intent that is already queued keeps its place and takes the newer path.
  - If checking an Intent throws (a repo or network error), the row stays and is tried again after 2 s; after 3 attempts the Intent is failed with the note "The gate could not check this Intent: ...".
  - An Intent that is not `queued` (or `gating`, from an interrupted attempt) when its turn comes is dropped from the queue untouched. That is how an Intent that went stale while queued leaves the gate.
  - `clear()` empties the queue; `reset-demo` calls it. `GET /api/gate` returns `status()`.
- **Gate priority is the task's position in `premise/tasks.json` on trunk** (1 for `t01`), then first in, first out. Intents whose task is not in the list (workload Intents) come after all agents. This is deliberately not the ledger priority from `priorityOrder`: with no order given, every agent has ledger priority 5, which would make the gate plain first in, first out.
- **Outcomes** (`landIntent`): landed → `act land`, `trunk.advanced`, `invalidate(...)`, metrics. Text conflict on path `rebase` → `act stale` with the conflicting paths in the note. Anything else that fails (type error, acceptance test, assertion, or any failure on path `rederive`) → `act fail` with the reason. **T17 changes the last one to stale-then-rederive.**
- **Path `rederive`:** the Intent stays `rederiving` (there is no `gate` action from that status); it lands straight from `rederiving`. T17 owns the rest.
- **The gate caches** (in the object's memory): snapshots by commit sha (8 kept) and the type surface of a file set. After a landing, the new trunk's files are stored under the new commit, so the next Intent rebases onto them without another read from Artifacts, and each Intent costs one compiler run. Every Intent dispatched together shares one base snapshot.
- **Event order for a clean landing:** `intent.status` (gating), `gate.result`, `intent.status` (landed), `trunk.advanced`, then `metrics`.
- **No `artifacts` event of type `pushed` is published for trunk by the gate.** T16's queue consumer publishes it from the platform's event; in memory mode there is none. If the UI needs a push count that includes landings in memory mode, publish one in `landIntent`, but not both.
- **Tests changed.** Three tests in `dispatch.workers.test.ts` asserted that Intents stop at `queued`. They now assert the stronger result: both Intents land on trunk through the gate; of two Intents on the same task, the one the ledger makes wait starts work only after the other has landed; and after a reset a new dispatch lands on the fresh trunk. They wait for `GET /api/gate` to be idle before resetting, because the gate publishes its metrics just after the status change.
- The runtime prints "your Worker's code had hung" a few times when the Workflow introspector is disposed at the end of those tests. It did so before this task too; nothing fails.

## 2026-10-09: T16 notes (premise invalidation and the queue consumer)

- **Files.** `gate/invalidate.ts` (`invalidate(env, landed)`, `invalidateWith(deps, landed)` and the pure `surfaceBreaks`, `assertionChecks`, `assertionBreaks`), `events/consumer.ts` (`interpret` pure, `handleArtifactsEvent`, `consumeBatch`), and the Worker's `queue()` handler now calls `consumeBatch`.
- **Verified on the deployed Worker with real Artifacts** (scripted agents): `t01` landed, and in the same second `t02` got `premise.broken` on `src/auth/session.ts#verifySession` with the reason "assertion 'verifySession throws SessionExpiredError on expired tokens' no longer holds after intent <t01>" and went `stale`; the gate then dropped it from its queue untouched.
- **What breaks what.**
  - Surface: the ledger's readers of `changedSymbols`, minus the lander and anything `landed`, `failed` or already `stale`. `breakPremise` is called with `{ sources: ["observed", "derived"] }`. Reason: `type surface of <export name> changed in intent <id>`.
  - Assertion: every holding asserted premise of every Intent that is not `landed`, `failed` or `stale` (so this includes `quarantined`, `gating`, `rederiving` and `escalated`, a superset of the task's list) runs in **one** isolate call on the new trunk, under the id `<intentId>:<assertion id>`. `breakPremise` is called with `{ assertionId }`. Reason: `assertion '<description>' no longer holds after intent <id>`.
  - The set of eligible Intents is taken once, before anything is broken, so an Intent that goes stale on a surface change in the same call still has its assertions checked and is told everything that broke.
  - If the new trunk does not load at all (`loadError`), no assertion is counted as broken.
  - `IntentDO.breakPremise` only turns an Intent `stale` from `working`, `submitted`, `checking`, `queued`, `gating` or `rederiving` (T10). An Intent still planning or waiting gets its premise marked broken and carries on; the gate is the backstop, because it runs every asserted premise.
- **A push from outside the gate** has no Intent to blame. `premise.broken.byIntent` and `brokenBy.intentId` are then the constant `OUTSIDE_PUSH` (`"outside-the-gate"`), and the reasons end "in a push to trunk" / "after a push to trunk". **The UI must not render that value as an Intent id.**
- **Idempotency.** The hub has a `processed_commits` table. `hub.claimCommit(sha)` is true the first time and false after, so whichever of the gate and the queue consumer gets there first does the work. `invalidate` returns `{ skipped, broken, intents }`.
- **Finding the Intents with assertions without opening every Intent.** The hub keeps `asserters`: the ids of Intents that have published a `premise.recorded` with source `asserted`. Invalidation opens only those (12 at a time). With 300+ workload Intents in flight this is what keeps a landing cheap.
- **Who publishes which `artifacts` event (a deviation from the task file).** Our own code publishes the counted events at the moment it acts: `forked` (dispatch), `pushed` (the agent's push to its fork, and now the gate's push to trunk, with `repo` = the trunk name). The queue consumer relays the platform's events under the platform's names, `repo.created`, `repo.forked`, `repo.imported`, `repo.deleted`, `repo.pushed`, which the counters ignore. So the fork and push counters are the same in memory mode, in Artifacts mode, and with or without the event subscriptions, and nothing is counted twice. (The task file has the consumer incrementing `forksCreated`; that would double count.)
- **Consumer behaviour for a push** (`repo.pushed`): always relayed. It is treated as a trunk push only if `source.repoName` is the current trunk, the ref is `refs/heads/main`, `after` is a commit sha and `before` is not all zeros. If `after` is already in `processed_commits` (the gate landed it) nothing more happens. Otherwise it reads both snapshots, computes the surface diff and calls `invalidate`. `byIntent` comes from the `Premise-Intent:` trailer of the pushed commit's message when there is one, so if the platform's event overtakes the gate's own call the result is the same.
- Every queue message is acknowledged, including one that throws, so a bad message is not redelivered forever.
- The event payloads were checked against Cloudflare's live schema page; a copy is in `docs/vendor/cloudflare/queues/event-subscriptions/events-schemas.fetched-2026-10-09.md` (git-ignored like the rest of `docs/vendor`).
- **HUMAN step still open: the two event subscriptions.** Nothing in the demo depends on them (the gate does its own invalidation), but without them the consumer never receives anything on the deployed Worker. Note that a subscription is per repo name, and `reset-demo` makes a fresh trunk called `trunk-<time>`, so a `pushed` subscription on `trunk` only sees pushes while the current trunk is the original `trunk` (after `import-trunk`).
  ```
  npx wrangler queues subscription create premise-events --source artifacts --events repo.created,repo.forked,repo.imported,repo.deleted --name premise-account
  npx wrangler queues subscription create premise-events --source artifacts.repo --events pushed --source-namespace premise --source-repo-name trunk --name premise-trunk-push
  ```

**Three things found while checking T16 on the deployed Worker.**

- **A Durable Object can keep running the previous version for minutes after a deploy.** After `npm run deploy` the Worker's routes ran the new code at once, but the `Landing` object went on running the old `landIntent` for at least three and a half minutes (no trunk `pushed` event, no invalidation). Before trusting a live check, look for something only the new code does, or wait.
- **Forking a repo that was imported moments ago can fail.** Five forks at once of a fresh trunk gave `ArtifactsError: An internal error occurred.`, and the retry then found the fork's name taken but the repo "not found". Three changes:
  - `ArtifactsRepoStore.fork` retries `INTERNAL_ERROR` / `UPSTREAM_UNAVAILABLE` up to 4 times (0.4 s, doubling), treats `ALREADY_EXISTS` on a later attempt as the earlier attempt having worked, and waits for a fork it was just told exists to stop being `NOT_FOUND`. Error names are the documented ones (`docs/vendor/cloudflare/artifacts/api/errors.mdx`).
  - `reset-demo` makes one probe fork of the fresh trunk, alone, and deletes it, before it says the trunk is ready. Reset now takes about 10 s. After this, reset followed at once by a five-task dispatch worked twice in a row.
  - `dispatchTasks` no longer fails as a whole when one fork fails: it starts what it can and throws `DispatchFailed { started, failed }`; `POST /api/dispatch` answers 502 with `{ error, intents, failed }` instead of an uncaught exception (Cloudflare error 1101).
- **(Resolved 2026-10-09 by standing checks; see the note of that name below.) Was: work that has already landed is not protected.** Invalidation and the gate protect Intents that are still in flight. If the Intent that relies on a behaviour lands *before* the Intent that changes it, nothing stops the second one: in one live run `t02`, `t03` and `t11` all landed, then `t01` landed last, and trunk ended up with three silent behavioural regressions and nothing red. The gate only runs the lander's own acceptance tests and assertions, and a landed Intent's premises are dropped ("a landed intent is never broken").
  - The demo works because `t01` lands while the others are in flight, so the demo script (T23) has to control that order; with task-order priority `t01` goes first only if it is in the same gate batch as the others.
  - It also matters for the A/B report (T19): in an unlucky order, Premise mode will show regressions on trunk.
  - A fix that fits the model: when an Intent lands, its holding assertions become **standing premises** of trunk, and the gate runs them for every later landing. A lander that breaks one does not land; it goes stale with "breaks a premise that landed Intent <id> relies on" and is re-derived or goes to a person. Roughly: one more hub table, a few lines in `gateOne`, and one more note format. **Not implemented: it is a product decision, so it is waiting for the user.**

## 2026-10-09: T17 notes (the re-derive race)

- **The whole demo scenario now runs end to end on the deployed Worker with real Artifacts** (scripted agents, no model key). Dispatch `t01`, then six seconds later `t02`, `t03`, `t04`, `t11`:
  - 25 s: `t01` lands. Within half a second `t02`, `t03` and `t11` each get `premise.broken` ("assertion 'verifySession throws SessionExpiredError on expired tokens' no longer holds after intent <t01>") and go `stale`.
  - Each race: the rebase is gated (typecheck passes; 1 acceptance test and 1 assertion fail, in about 0.7 s), a fresh fork `<id>-r1` is made, the agent re-derives, the result is gated and lands. `rederive.race` ends `fail / pass`, winner `rederive`. All three landed by 68 s.
  - `t04`, the control, landed on its first attempt, untouched.
  - Final metrics: `premisesBroken` 3, `rederives` 3 started / 3 succeeded / 0 failed, `intentsLanded` 5.
- **Files.** `gate/rederive.ts` (`RederiveScheduler`, `MemoryRederiveStore`, `startRace`, `finishRederive`), `gate/land.ts` (`gateDeps`, the gate cache, `landWork`, `landIntent`, `settle`; moved out of `landing.ts`), `gate/landing.ts` (now only the Durable Object), `agent/instance.ts` (`workflowInstanceId`).
- **The race is sequential, not parallel (a deviation from the task file).** The rebase attempt takes about a second and costs nothing, so it always has its answer first. The agent is therefore started only once the rebase is known not to land. The outcome is the same as racing them (a passing rebase always wins) and no model call is spent on a run that would be cancelled. Events still tell it as a race: `pending/pending`, then `fail/pending` or `pass/pending` + winner `rebase`, then `fail/pass` + winner `rederive` or `fail/fail`.
  - The rebase attempt is a real gate run, not a dry run followed by a second run: this object is the only writer to trunk, so a pass can land at once. `gateOne` does have `opts.dryRun` as the task asks (tested; `report.ok` then means "would land" and `landedCommit` stays null), for the A/B harness or anything else that wants the verdict without the commit.
  - The rebase attempt is skipped when the Intent never pushed anything, and when the gate has just rejected this same rebase onto this same trunk commit (`StaleEntry.rebaseFailedAt`), so the identical check is not run twice.
- **A gate failure on a first attempt now means `stale`, not `failed`** (any failure: text conflict, type error, acceptance test, assertion). `landIntent` returns `{ kind: "stale", trunkAt }` and the Landing object queues the re-derive. On path `rederive` a failure leaves the status alone and returns `{ kind: "failed" }`; the race decides between another attempt and a person.
- **Who gets a stale Intent re-derived.** Whoever made it stale tells the Landing object: the gate itself, after a landing (`InvalidateResult.stale`, a new field) or after rejecting a rebase; and the queue consumer, after an outside push (`landing(env).noteStale(id)`). `invalidate` does not call the Landing object itself, because most calls come from inside it.
- **Scheduler.** `stale_queue(intent_id, priority, since, rebase_failed_at)` and `running(intent_id, attempt, started)` in the Landing object's SQLite. At most `MAX_CONCURRENT_REDERIVES` (default 3) agents re-derive at once; the rest wait, lowest task-order number first, then longest waiting. A race that ends at once (the rebase landed) never holds a slot. Races are started inside the one alarm pass, one after another (about 5 s each on real Artifacts: gate run plus fork), so three stale Intents start about 5 s apart.
- **Failure counting is the Landing object's own** (`rederive_failures`), separate from `Intent.rederiveAttempts`, which only ever goes up because it names the fork (`<id>-r<n>`) and the Workflow instance (`<id>-<n>`). After 2 failed re-derives in a row: `escalated`, and `human.needed` with kind `fallback` and options `Retry` / `Abandon`. A landing resets the count.
  - `POST /api/human/:id` with `Retry` or `Abandon` on an `escalated` Intent goes to `landing.humanChoice`. Retry allows exactly one more attempt (then back to a person). Abandon fails the Intent and removes it from both queues.
  - A re-derive counts as failed when: its gate run does not pass; its agent cannot finish (the Workflow calls `landing.rederiveFailed(id, attempt, reason)` through the new `AgentDeps.giveUp`, instead of failing the Intent); the gate cannot check it after 3 tries; the race cannot be started after 3 tries; or the agent has not come back after 20 minutes (`RACE_TIMEOUT_MS`).
  - If trunk moves again and breaks a re-deriving Intent's remaining premises, that attempt is void: its agent is terminated (`instance.terminate()`, per the Workflows docs), `rederive.race fail/fail` closes it, and the Intent queues again. This does not count towards the 2.
- **What the re-deriving agent is told.** `restartOn` clears broken premises from the Intent (T10), so the Landing object passes them in the Workflow's parameters (`AgentParams.broken`) and the briefing lists them with their reasons. `AgentParams.attempt` is the attempt number.
- **Guards against an overtaken run** (`agent/run.ts`). An Intent can go stale, and its re-derive can start, while its first agent run is in the middle of a model call. That run must not touch the staged files or the fork, which now belong to the re-derive, and must not fail the Intent. So:
  - a run re-reads the Intent after every model reply, before running any tool call, and again in its push, record-push and hand-off steps; a re-derive run also stops if `rederiveAttempts` is no longer its own attempt number;
  - those steps return "stopped" as a value instead of throwing, because a throwing Workflow step is retried and its error does not come back as the same class;
  - a run that errors only fails the Intent if the Intent is still its own (first attempt: `planning`, `claiming`, `waiting`, `working`, `submitted`, `checking`). Otherwise it reports `stopped`. **A stale Intent's first run therefore ends `stopped` and the Intent keeps its claims for the re-derive.**
- **`GET /api/gate`** now returns `{ queue, busy, stale, rederiving }`. The two new fields are a quick way to tell that the Landing object is running the new code after a deploy.
- **Tests changed.** In `gate.workers.test.ts` the acceptance-failure case now expects `stale`. `invalidate.workers.test.ts` ends its frozen Intents explicitly, because a stale Intent's run no longer fails it. The escalation test logs "ScriptedLlm has no turns" several times: that is the failing re-derive it is testing.
- The product question recorded under T16 (work that has already landed is not protected) was open at this point; standing checks, below, close it.

## 2026-10-09: Free model options on OpenRouter and Google AI Studio (looked at, not tested)

The user asked for a free model to use in place of an Anthropic key. Nothing here was run: there is still no key of any kind.

- **Source for OpenRouter:** its public model list (`GET https://openrouter.ai/api/v1/models`, fetched today). Of 458 models, 19 are free and 16 of those accept `tools`.
- **OpenRouter's free limits** (its docs, "Limits"): 20 requests a minute on `:free` models; **50 requests a day** if the account has bought fewer than 10 credits, **1,000 a day** once it has bought at least 10 (a one-off purchase; free models do not spend them).
  - One agent run is roughly 8 to 32 model requests, and a 12-agent run with re-derives is 150 to 450. So 50 a day is not enough for anything but a single-agent check; 1,000 a day is two to six full runs.
  - 20 a minute is below what 12 agents ask for at once. `llm-http.ts` retries a 429 three times with backoff, which will not be enough on its own: a small limiter in front of the provider will be needed.
- **Suggested model: `poolside/laguna-s-2.1:free`.** Built as a coding agent, tool calling and `tool_choice`, 262K context, 32K output. Poolside reports 70.2% on Terminal-Bench 2.1 with its own harness; no independent test was found. **The free listing expires 2026-10-31.** Poolside may train on free-tier inputs (the demo repo is public). Serving guidance says to send the model's earlier reasoning back in the history; `llm-openai.ts` currently rebuilds the assistant message from `content` and `tool_calls` only, so it needs to carry the reasoning fields through `raw` before this model is used.
- **Fallback with no expiry: `nvidia/nemotron-3-ultra-550b-a55b:free`** (550B/55B active, 1M context, described as for agent orchestration and coding agents; third-party indices put it mid-table). Smaller code-specific option: `cohere/north-mini-code:free`.
- **Google AI Studio:** the free daily limit for Flash models still cannot be confirmed from outside. Reports range from about 20 a day (a September 2026 guide, for 3.5 to 3.8 Flash) to 1,500, and 500 a day for Flash-Lite. The real number is per project at `aistudio.google.com/rate-limit`.
- **If a little money is acceptable:** on OpenRouter today `anthropic/claude-haiku-5.5` is $0.10 / $0.50 per million tokens in / out, which puts a full 12-agent run at roughly half a dollar, with no daily cap. The $10 that lifts the free limit to 1,000 a day would also pay for about twenty such runs.
- **To switch, no code change is needed:** `LLM=openrouter`, `LLM_MODEL=<id>`, and the key as `OPENROUTER_API_KEY` in `.dev.vars` and `wrangler secret put OPENROUTER_API_KEY`. `LIVE_LLM=openrouter npm test -- llm` runs the live adapter check.

## 2026-10-09: Standing checks (protecting work that has already landed)

The user approved the fix proposed under T16. It is not in `SPEC.md` or any task file.

- **The rule.** When an Intent lands it leaves behind its acceptance tests and the assertions it made that still hold. For every later landing the gate runs those too, in the same isolate run as the lander's own checks:
  - if a landed Intent's **acceptance test** fails on the rebased files, the lander does not land. It goes `stale` with a note such as `Breaks landed Intent <id>: its acceptance check "<name>" fails (<error>). It relied on: <assertion description>.`, and is re-derived like any other stale Intent;
  - a lander may not edit or delete the file of a landed acceptance test (compared with trunk's copy; such tests fail without being run);
  - a landed Intent's **assertion** that no longer holds while its acceptance tests still pass is retired. It never blocks by itself.
- **This differs from what I first described to the user** ("its assertions become standing checks"). With assertions as the blocking check, a legitimate behaviour change that anyone had ever relied on could never land: the assertion "verifySession throws" contradicts `t01`'s own goal, so no re-derive of `t01` could pass. With the acceptance tests as the check, the re-derive has a way through: keep its change and repair the code that depended on the old behaviour. The assertion's job is to say why.
- **Where they are stored:** the Landing Durable Object's SQLite, tables `standing_tests(intent_id, file, name)` and `standing_assertions(intent_id, assertion_id, symbol, assertion)`. The test files themselves are on trunk. `reset-demo` clears them. `landing(env).standing()` returns them. Not in git; committing them to trunk with each landing would be a contained change if wanted.
- **A check applies only if its test file exists on the trunk being landed on.** That keeps checks recorded against one trunk from leaking onto another (it matters in tests, where many private stores share one Landing object), and it is what makes deletion detectable.
- **Code.** `gate/standing.ts` (pure: `standingOf`, `planStanding`, `standingRequest`, `judgeStanding`, `describeStandingFailure`, `MemoryStandingStore`). `gateOne` takes `opts.standing` and returns `standingFailures` and `retired`. `landWork` reads the store, and on a landing adds the Intent's entry and retires what the landing made untrue. `LandDeps.standing` is optional; without it nothing is protected (private-store tests that do not pass one behave as before).
- **In a `GateReport`,** `tests.passed` lists only the Intent's own tests. A landed check that fails is added to `tests.failed` with the error prefixed `(acceptance check of landed Intent <id>)`. Landed assertions never appear in the report.
- **The agent finds out before the gate does.** `run_checks` (and so `submit`) also runs the landed checks against the agent's files, and prints `FAIL  landed Intent <id>  "<test>"` and what that Intent relied on. It says nothing about landed work when it all passes. `AgentEnv` gained an optional `LANDING`; `createToolContext` takes an optional `standing` function for tests.
- **The re-derive is told why.** The gate's one-line reason travels `StaleEntry.reason` → `AgentParams.reason` → the briefing ("Why your earlier work did not land"). When the reason is about landed work, the briefing adds what to do: keep the change, update the code that depended on the old behaviour, declare those symbols, do not edit the test. This applies to every gate rejection, not only standing ones (a type error after rebase is passed on the same way). `stale_queue` gained a `reason` column, added with a guarded `ALTER TABLE` because the table already exists on the deployed object.
- **Checked on the deployed Worker.**
  - The order that used to break trunk: `t02` and `t03` land, then `t01` is dispatched. `t01`'s own `run_checks` now fails on the landed checks, its `submit` is refused, and trunk keeps `t02` and `t03` intact. Because the agents are scripted, `t01` then has no more recorded turns and its run fails with "ScriptedLlm has no turns", which is an artefact of replaying a recording: a real model would read the failure and repair the callers. The same order through the gate (hand-built Intents in `standing.workers.test.ts`) gives `stale`, two failed re-derives, and a person asked.
  - The demo's own order (`t01` first) is unchanged: 3 premises broken, 3 re-derives succeeded, 5 landed, 64 s.
- **Not covered:** a push to trunk from outside the gate cannot be stopped, so landed checks are not run for it (in-flight Intents are still invalidated). And a landed Intent with no acceptance tests leaves nothing behind.
- **For T18:** workload Intents have no tests or assertions, so they leave nothing standing, but the standing checks of the real agents should still run when a workload Intent lands.

## 2026-10-09: T18 notes (scripted workload agents)

- **Files.** `workload/generate.ts` (pure, seeded with mulberry32), `workload/bucket.ts` (`TokenBucket`), `workload/run.ts` (`planWorkload`, `runWorkloadIntent`, `spawnInProcess`, `spawnWorkflows`, `runWorkload`), route `POST /api/admin/workload { n, seed?, concurrency?, overlapRate? }`.
- **Live result, n = 300, seed 7, deployed Worker, real Artifacts:**
  - All 300 started in 29 s. 295 forks were made (5 lost to fork errors that outlasted the retries; see below). All had reached the gate or failed within about 50 s.
  - **266 landed in 252 s**, about 70 landings a minute once the gate was busy. 29 gave up waiting for a claim (exactly the 29 edits generated to overlap another).
  - 150 premises were broken along the way (an interface gaining a field invalidates everyone who read anything that mentions it); every stale Intent was settled by the gate re-trying its rebase. `humanMerges` 0, broken builds 0.
  - No rate-limit errors from Artifacts were seen.
  - Before batching the same workload landed 201 in 600 s (about 20 a minute, with 34 still queued), and 61 gave up on claims because edits collided by accident.
- **The four edit kinds** are as the task says, with these particulars:
  - Helper (about 50%): `src/generated/w<seed>_<i>.ts` exporting `w<seed>_<i>`, which calls one or two existing exported functions through `Parameters<typeof f>` / `ReturnType<typeof f>`, so it typechecks for any function. Reads those functions; claims only the new symbol.
  - Body (about 30%): a comment and `const _w<seed>_<i> = 0;` on the first line inside a multi-line function body. Claims the body.
  - Field (about 15%): an optional `_w<seed>_<i>?: number` at the end of an interface. Claims the interface. Interfaces whose keys are enumerated somewhere (`keyof X`, `Required<X>`, `Readonly<X>`) are never chosen.
  - Overlap: with probability `overlapRate` (default 0.1) an edit goes for a function an earlier body edit touches. Ordinary body and field edits are dealt without repeats until every target has been used, so contention comes from the overlaps on purpose and not from accident.
  - Names carry the seed, so two runs with different seeds never add the same name.
  - Tested exhaustively, not on a sample: a helper wraps every exported function in the demo repo, a body edit fits every multi-line function, and a field edit fits every eligible interface, and each result typechecks.
- **An edit is plain data** (`EditSpec`) and is applied to the fork's own copy of the file at the fork's base, not to the files the run was planned on. Trunk moves during a run; applying to stale files would silently undo other landings.
- **Each workload Intent is its own Workflow instance on the deployed Worker** (`AgentWorkflow` handles `mode: "workload"` as one step with no retries). One invocation cannot make the requests 300 Intents need (10,000 subrequests an invocation; each Intent makes on the order of 100). `createBatch` starts them 12 at a time, paced by a token bucket at about 150 Artifacts calls a second (12 calls an Intent). In memory mode and in tests the jobs run in-process (`spawnInProcess`), with every store call taken from the same kind of bucket.
- **Workload Intents never involve a model or a person.** If the ledger says wait, split or depend, it asks again three times (0.5, 1, 2 s) and then fails. If one goes stale: when its rebase is worth trying it goes back into the gate's queue (so stale ones land in batches too) and `rederive.race` reads `pending/pending` then `pass/pending` with winner `rebase`; when the gate has just rejected that same rebase, or it never pushed, it is failed at once with no race. No fork is made for it and no card is shown.
- **Batch landing (the task allows it; this is what it does).** Up to 10 workload Intents at the front of the gate's queue land as one commit: each is rebased in turn onto trunk plus the ones before it, the result is typechecked once, the landed Intents' standing checks run once, one commit goes to trunk (`batch of N workload intents`, with a `Premise-Intent:` trailer for each).
  - Each member still gets its own `gate.result` and `landed` status. Trunk gets one `artifacts` `pushed` event whose `detail` has `batch: N` and `intents: [...]`, and one `trunk.advanced`. **The UI should show this as "batch of N".**
  - A member that conflicts with an earlier one is left out and gated alone, so it gets its own verdict. If the merged result does not typecheck or breaks a landed check, nothing lands and every member is gated alone.
  - An agent's Intent is never batched: it has checks of its own.
  - When a batch changes several type surfaces, each `premise.broken` names the member that changed that symbol (from the members' interface claims; a symbol that changed only because it mentions another is put down to that other's member). `Landed.changedBy` carries this into `invalidate`.
- **`GateDeps.delta`** (optional): an Intent's head is built from its base plus the files that changed (`changedPaths` + `readFile`) instead of reading the whole tree again. About half a second saved per Intent on Artifacts.
- **`GET /api/gate` reports `version`** (`GATE_VERSION` in `gate/landing.ts`). Bump it when the gate changes and wait for it after a deploy. One live measurement here was wasted on a Landing object that was still running the previous code five minutes after the deploy.
- **Things to know.**
  - About 19 events per workload Intent: 300 Intents is some 5,000 events. `hub.since` returns at most 5,000 at a time, so **anything that replays the log must page** (`since=<last seq>`).
  - 5 of 300 forks failed even after 4 attempts, in the first seconds of the run when 12 forks a second were being made. Those Intents never came into being (no record, no event). Lowering `concurrency` in the request body lowers the fork rate.
  - Workload Intents have ledger priority 50, so an agent always wins a contested symbol, and gate priority after every demo task.

## 2026-10-09: T19 notes (A/B harness)

- **Files.** `ab/run.ts` (`startAbMode`, `isQuiet`, `collectAb`, `runAbMode`), `ab/report.ts` (pure: `ModeResult`, `buildReport`, `renderMarkdown`), `ab/regress.ts` (pure), `scripts/ab.ts`, routes `POST /api/admin/ab` and `POST /api/admin/ab/result`. Results: `docs/ab-results.md` and `docs/ab-results.json`.
- **Live result** (deployed Worker, real Artifacts, scripted agents, 12 tasks + 100 workload Intents, seed 7), headline generated from the numbers: **"Baseline shipped 3 behavioural regressions and needed 11 human merges; Premise shipped 0 behavioural regressions and needed 0 human merges."** Both landed 12 of 12 tasks and 97 Intents. Baseline took 100 s, Premise 136 s. Premise broke 26 premises: 3 were settled by re-derive and 18 by a plain rebase, a false-positive rate of 82%, almost all of it workload Intents invalidated by another workload Intent adding an interface field. The numbers in `docs/ab-results.*` are from the latest run and may differ slightly.
- **The two modes run one after the other, each from a reset** (a deviation: the task has them on `trunk-base-<run>` and `trunk-prem-<run>` with the trunk name passed through everything). A reset already gives a fresh copy of trunk, an empty ledger, an empty event log and an empty gate, so each mode is isolated without threading a trunk name through dispatch, gate, invalidation and workload. The cost is that an A/B run wipes whatever demo was on screen.
- **Mode is a setting in the hub** (`hub.mode()`, `currentMode(env)`; a reset puts it back to `premise`). In `baseline`:
  - the agent asks no ledger (its claims are recorded and granted without a question), `run_checks` runs no landed checks, and the hand-off skips the post-push checker;
  - the gate lands on `threeWayRebase` + typecheck alone (`gateOne` with `skipTests` and `skipAssertions`, report path `baseline`), keeps no standing checks and invalidates nobody;
  - a text conflict publishes `human.needed` (kind `fallback`, option `Abandon`) and fails the Intent; a type error after rebase just fails it;
  - workload Intents skip the ledger and the checker too, and are batched the same way.
  - The rebase function, the typecheck, the agents' recorded work and the workload are identical in both modes.
- **Behavioural regressions are measured, in every run, not only A/B.** After each landing the gate runs the hidden reference tests (`premise/hidden-tests/<task>.test.ts`) of every demo task that has landed, against the new trunk. A test that is newly red adds one to `behaviouralRegressionsOnTrunk`. It only measures; it never blocks. So the UI's counter is real in a normal demo run as well.
- **`humanMerges` now counts only when a person was actually needed** (a change to T12's rule): a `human.needed` of kind `fallback` counts when raised; a `stalemate` card counts only if someone answers it (`human.resolved` with Wait, Split or Depend). The planted `t05`/`t06` collision shows a stalemate card and then settles by itself when the other Intent lands; that is not a human merge.
- **Choreography: `landFirst`.** `POST /api/dispatch` takes `landFirst: [taskIds]`; the gate holds the other Intents of that dispatch until those have landed or stopped (`landing.hold`). It only orders landings. The A/B run uses it with `t01` in both modes so both see the same order, and **the demo script (T23) should use it too**: without it, which Intent lands first depends on which agent finishes first.
- **Honest costs of Premise visible in the report:** it is slower (re-derives and re-tried rebases), it invalidates far more than it needs to for the workload, and some workload Intents give up on a claim where the baseline would have produced a text conflict for a person instead.
- **Not done:** recorded-from-a-real-model scripts (T23) and a `--live` option. The agents' work is the reference-solution scripts.

## 2026-10-09: Gemini models on the free tier (measured by a background agent), and three fixes

- **Use `gemini-3.5-flash-lite`** (`LLM=google`; it is now the `google` default), with `gemini-3.1-flash-lite` as the fallback. Measured with a new gated harness, `src/worker/agent/live.workers.test.ts` (`LIVE_AGENT=google LIVE_MODEL=... LIVE_TASK=... npx vitest run --project workers src/worker/agent/live.workers.test.ts --silent=false --reporter=verbose`).
  - 3.5 Flash-Lite: 27 of 27 task runs outside `t01` submitted and passed the hidden reference tests. 3.1 Flash-Lite: 16 of 19, the three failures being API error bursts.
  - The regular Flash models (3.6, 3.7, 3.8) are not usable on this key: 20 requests a day or 5 a minute, and each used all its plan turns exploring without declaring changes.
  - **Free limits (from the 429 bodies):** 15 requests a minute per Flash-Lite model; 500 a day for 3.5 Flash-Lite. The day resets at 17:00 PDT. One 12-agent run takes 140 to 170 successful requests and 6 to 10 minutes, because 12 agents share 15 requests a minute. Two full runs a day fit per model.
  - Thought signatures travel on each tool call (`extra_content.google.thought_signature`); the adapter already replays tool calls whole, so multi-turn tool calling works. It now also keeps `message.extra_content` on replies without tool calls.
- **Fixes made from what it found:**
  - **Retry waits.** Gemini puts the wait in the error body (`"retryDelay": "35s"`), not a header; the adapter now reads it, waits up to 60 s, and does not retry when asked to wait longer (a used-up daily quota). Hint-less 429s and 503s are retried 5 times over about a minute (2, 4, 8, 16, 30 s) instead of 3 times over 7 s, which had been ending agent runs.
  - **`t01` trapped itself:** the model adopted `a-session-throws`, then broke it with its own change, and `submit` refused for the rest of its turns. `t01` now has a hint saying not to adopt it (`demo-repo/premise/tasks.json`, published to `akshat12/acme-accounts`). Checked live: 3.1 Flash-Lite then finished `t01` in 7 turns and 16 s with both reference tests passing. A general fix (letting an agent withdraw a premise) is not built.
  - **Overwriting shared test files:** `write_file` now refuses a path under `tests/` that already exists in the repo unless it is one of the Intent's own acceptance test files. The models had replaced `tests/support.ts`, `tests/users.test.ts` and `tests/billing.test.ts` in three runs, and nothing would have noticed.
- **Not yet tested with a live model:** landing, invalidation and re-derive (the harness stops at the gate's queue), and real Workflows and Artifacts. A 12-agent live run needs a limiter for 15 requests a minute to be smooth; today it gets through on retries.
- The key is in `.dev.vars` only. It was pasted into the chat, so it should be rotated once the competition is over.

## 2026-10-09: T12 closed: a real model, end to end, on the deployed Worker

- **Choosing the model at run time.** `POST /api/admin/llm { provider, model? }` stores the choice in the hub (`hub.llm()`); every agent run reads it in its first Workflow step (`withChosenLlm`). `{ provider: null }` goes back to the Worker's own `LLM` var (scripted). It refuses a provider whose key is not set. It survives a reset, like the trunk name. The Gemini key is a Worker secret (`GEMINI_API_KEY`).
- **T12's live check** (the task says `LLM=anthropic`; this used `google` / `gemini-3.1-flash-lite`, the only key there is): `t07-role-check` dispatched on the deployed Worker went planning → working → quarantined (it added `Resource` and `RESOURCE_MIN_ROLE` without declaring them; the claim upgrade was granted by itself) → gate (3 acceptance tests passed) → landed, in 93 s.
- **The premise-break scenario with a real model**, dispatching `t01`, `t02`, `t04` with `landFirst: ["t01-null-expired"]`:
  - 44 s: `t01` landed.
  - 44 s: `t02`, which had adopted `a-session-throws` while planning, got `premise.broken` and went `stale`. It had pushed nothing yet, so there was no rebase to try.
  - 45 to 211 s: the re-derive. The model read the new trunk and wrote its reasoning ("verifySession now returns null for expired sessions instead of throwing an error. I will modify handleLogin to detect expired sessions by checking store/now instead of catching an error."). The result passed the gate and landed; `rederive.race` ended `fail / pass`, winner `rederive`.
  - 329 s: `t04`, the control, landed on its first attempt.
  - `behaviouralRegressionsOnTrunk` 0 (the hidden reference tests of all three passed on trunk), `premisesBroken` 1, `rederives` 1/1/0.
  - It is slow because three agents share 15 requests a minute; most of the time is waiting out 429s.
- Afterwards the live Worker was put back to recorded agents (`provider: null`) and reset.
