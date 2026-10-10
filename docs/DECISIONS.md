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
