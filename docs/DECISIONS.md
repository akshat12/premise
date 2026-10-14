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

## 2026-10-09: T20 notes (UI shell, counters, strip board)

- **Files.** `src/ui/theme.css` (tokens and the strip, chip, bay, stamp and red-pen styles), `src/ui/lib/view.ts` (pure: callsigns, status looks, bays, chips, annotation, lanes, ledger rows), `src/ui/lib/useViewState.ts`, `src/ui/components/{TopBar,Counter,Strip,Lanes,LedgerRail,Drawer}.tsx`, `src/ui/App.tsx`. Screens: `docs/screens/t20.jpg` (the premise break) and `docs/screens/t20-end-with-drawer.jpg`.
- **Light mode is forced** three ways that agree: `color-scheme: only light` on `:root` (in `theme.css` and inline on `<html>`), `<meta name="color-scheme" content="only light">`, and `data-mode="light"` on `<html>`. Kumo's colours are written with `light-dark()`, which follows `color-scheme`; its dark theme is otherwise switched on by `data-mode="dark"`, which is never set. Checked by emulating a dark system: `prefers-color-scheme: dark` matched and the page stayed light.
- **The replay plays a real run, not a hand-written one.** `src/ui/fixtures/real-run.json` is the event log of the deployed Worker running the 12 recorded agents (`landFirst: t01`) plus 40 workload Intents: 1,119 events over 99 s. It is loaded on demand as its own chunk. `sample-run.json` (hand-written, T04) is still there for the reducer's tests.
- **`?frame=N`** shows the recording as it stood after its first N events and stops there (the pill says "Still · event N"). Event 360 is the premise break. `?live` opens on the live stream.
- **Strips are 48px tall, not 56.** Kumo's Flow lays nodes out itself with 16px between lanes and 64px between nodes, and clips what does not fit. 13 lanes at 56px need 920px; at 48px they need 816px, which fits under the top bar at 1440×900.
- **The strip's width follows the window** (`stripWidthFor`): whatever is left after the backlog, the three bays and the gaps, so all bays stay on screen from 1280 up. Bays have fixed widths and one word each; a failed gate shows a red cross and says why in its title and in the strip's note.
- **What a strip shows:** the holder band, the callsign (`T02 AUDIT`, from the task id), a status icon and word, then up to three chips (pencil = changes, eye = relies on; filled icon = interface claim or asserted premise). With a red-pen note, the struck-through chip and the note come first and the other chips give way. Broken premises are not shown once the Intent has landed.
- **The re-derive stamp counts races** (`IntentView.races`, counted in the reducer from `rederive.race` events that start with both legs pending), because no event carries `rederiveAttempts`.
- **The ledger rail lists agents' Intents only**, broken symbols first, then contested ones. Workload Intents would bury them.
- **View state is reduced incrementally** (`useViewState`): only the events that arrived since the last render are applied.
- **Hover a chip or a ledger row** and every strip that does not touch that symbol dims to 40%. `j`/`k` move between strips, `Esc` closes the drawer. The command palette and shortcuts sheet are left for T22.
- **Counters:** the two hero numbers are Broken builds on trunk and Human merges; then Agents active, Landed, Premises broken, and "Stale, settled" (`rederives.succeeded`, which counts stale Intents settled by a rebase as well as by a re-derive).
- **Not in this task:** dispatching from the UI (the button says so), the full drawer (T21), human cards (T22). The live stream sends at most 5,000 events of backlog; a run with more needs paging.
- **Self-critique.**
  - Five-second test at the break (`?frame=360`): three red strips each say "verifySession changed", the ledger's top row is `verifySession` with three readers struck through, and nothing else on screen is red.
  - Changed after looking: the note used to overlap the chips (it now sits right after the struck chip); callsigns wrapped (one line now); the last bay ran under the rail (width now follows the window); a landed strip still showed its struck chip (hidden once landed); "Re-derived" over-claimed (renamed).
  - Taken away: the file name on every plain ledger row. Nothing felt missing.
  - Keep consistent in T21 to T23: red is only ever a broken premise or a failed gate; blue only the re-derive stamp, the workload strip's band and the replay pill; no shadows, 3px radius, 1px `--rule` borders; callsigns are the only uppercase.
- The screenshot tool returns images scaled to 800px wide, so the saved screens are that size even though the page was laid out at 1440×900.

## 2026-10-09: T21 notes (strip details and the drawer)

- **Files.** `src/ui/lib/chips.ts` (pure: `groupPremises`, `raceRows`, `sharedSymbols`, `timelineFor`, `ago`, `openCards`), `src/ui/components/Drawer.tsx` (now the real one), additions to `Strip.tsx` (`RaceIndicator`, the "if" suffix, shared-chip outline). Screen: `docs/screens/t21.jpg` (`?frame=760`, T02 selected).
- **`docs/UI.md` wins over the task file on the strip's first line:** it is the callsign and a status word, not a truncated goal. The goal is in the strip's `aria-label` and in the drawer.
- **Chips.** Pencil = changes (with a small "if" when the claim is on the interface). Eye in green = relies on, holding. Flag = relies on behaviour it asserted. Broken = red, struck through with the red-pen line. A chip whose symbol one agent is changing while another relies on it gets an amber outline on both strips (one colour for "shared", matching the ledger's "contested", instead of a colour per pair: more accents would compete).
- **Chip order** follows the task: asserted first, then anything else broken, then derived, then observed; at most three, then "+N" (three, not four, because of the strip's width). When there is a red-pen note, the struck chip and the note lead.
- **Race indicator:** two rows, `rebase` and `re-derive`, each with an hourglass, a tick or a cross; the winner is bold. It sits at the right end of the strip and in the drawer's header.
- **Drawer:** three columns. *Why* (up to three lines the agent gave, then what it changes). *Relies on*, grouped Asserted / Derived / Observed with a one-line meaning for each; a broken row is struck through, gives the reason, and links to the Intent that caused it. *Timeline*, newest first, from the event log: status changes, broken premises, gate verdicts, race steps, ledger answers, and anything asked of a person, each with a relative time measured from the latest event on screen (so a replay reads correctly).
  - When the Intent is stale or re-deriving, the header's subtitle is "A premise broke: re-deriving on new trunk".
  - **Rejected alternatives are not shown:** no event carries them (`IntentSummary` has no `rejectedAlternatives`), and `src/shared/events.ts` is fixed.
  - Messages from the backend name Intents by id; the drawer rewrites those as callsigns (`named` in `App.tsx`).
- **Self-critique.** Five-second test with T02 selected at the break: the red subtitle, the struck `verifySession` with "verifySession throws SessionExpiredError on expired tokens" under it, and the agent's own first "why" line ("Audit entry in the catch branch: relies on verifySession throwing") say what broke and why without scrolling. Changed after looking: raw Intent ids in reasons became callsigns; the last bay was clipped once a scrollbar appeared (16px is now reserved); the note lost ": re-deriving" when the race rows are showing, since the status word says it. Taken away: nothing more; the drawer has no decoration to remove.

## 2026-10-09: T22 notes (human cards, dispatch panel, palette)

- **Files.** `src/ui/lib/api.ts` (the only place the UI calls the admin API), `src/ui/components/HumanCards.tsx`, `DispatchPanel.tsx`, `Palette.tsx` (`Palette` and the `?` `Shortcuts` sheet). Screen: `docs/screens/t22.jpg` (live, local, 12 tasks and 20 workload Intents, the stalemate card open).
- **Acceptance, as run.** `npm run dev` with `REPO_STORE=memory`, `LLM=scripted`: the panel dispatched 12 tasks and 20 workload Intents; the card "Two Intents both want computeTotal" appeared for T05 and T06; **Split** gave T05 the symbol (`claim.decision granted`, status `queued` with "The contested symbols were given to this Intent", then `human.resolved`), and both landed (29 landed; the 3 that did not were workload Intents that lost a symbol or hit a text conflict, as in T18).
- **The stalemate card is short-lived on purpose, and very short-lived locally.** A quarantined Intent is re-checked the moment the Intent it waits on lands, so the card is an offer to settle it sooner, not a stop. With the in-memory store that is about 1.2 s, too fast for a hand: the click was verified with a page observer that pressed Split as soon as the card rendered, and the screenshot was taken with the page's socket paused. On the deployed Worker a landing takes seconds, not milliseconds. **T23:** if the video needs a person to click Split, the demo script has to hold the other Intent (for example with `landFirst`), or show the card in the replay.
- **A card closes when** `human.resolved` arrives **or** the Intent leaves `quarantined`/`escalated` (`openCards`). After a click it shows "<choice> applied" until then. In a replay the buttons are off and say why.
- **Card copy.** Stalemate title names the contested symbols ("Two Intents both want computeTotal"), then both callsigns with the first sentence of each goal, two lines at most. Each button has one line under it saying what it does; **Split** is "Give the contested symbol to this Intent now", which is what `settleQuarantine` does. Fallback title is "Re-derive failed twice" with the last gate errors (three lines at most) and **Retry / Abandon**.
- **Dispatch panel.** A left slide-over. Tasks come from `GET /api/tasks`, all ticked. "Land T01 first, while the others are in flight" is on by default and sends `landFirst`, because without it the order of landings is whatever finishes first and the premise break may not show. Workload count (0–500) and seed; the workload is started after the dispatch call returns. Starting a run switches the board to Live. "Reset demo" is in the panel's footer.
- **Admin token.** Typed once into the panel, kept in `sessionStorage` (try/catch), sent only as the `Authorization` header. It is never put in a URL and never logged. A card clicked without a token opens the panel.
- **Two token files now.** `.dev.vars` holds the local dev token (`local-admin-token`, also in `.dev.vars.example`); `.env.deployed` (git-ignored) holds the deployed Worker's token. `scripts/smoke.ts` and `scripts/ab.ts` look in the environment, then `.env.deployed`, then `.dev.vars`. This keeps the real token out of anything a browser test types.
- **⌘K palette** (Kumo `CommandPalette`): Dispatch tasks, Run workload, Reset demo, Watch live, Play the recording, Show keyboard shortcuts, and "Jump to <callsign>" for every strip (opens its drawer). **`?`** opens the shortcuts sheet.
- **Self-critique.** Five-second test with the card open: the only red on screen is the card's left edge and bell; its title says what is contested and the amber Check bay on T05's lane says where. Changed after looking: goals on the card were whole paragraphs with code ticks (now one sentence, two lines); the shortcuts sheet had the browser's focus ring around it (removed); a tooltip wrapped a button and nested two `<button>`s (plain `title` now). Taken away: nothing this pass. Known and left: the card sits over the top of the ledger rail while it is open; the workload count is not remembered between openings of the panel.

## 2026-10-10: T23 notes (demo mode, scale view, A/B panel)

- **Files.** `src/ui/lib/demo.ts` (pure: `compressRun`, `formatCut`/`parseCut`, `realTimes`, `nextStop`), `src/ui/lib/scale.ts` (pure: `scaleStats`, `bucketCounts`, `artifactsOperations`, `operationsCost`), `src/ui/components/ScaleView.tsx`, `AbPanel.tsx`, `scripts/record-run.ts`, `scripts/compress-run.ts`, `scripts/lib/admin.ts`. Recordings: `demo/runs/<name>.json` (what plays), `demo/raw/<name>.json` (the same run before cutting).
- **Record.** `npx tsx scripts/record-run.ts --url <worker> --out demo/runs/<name>.json [--workload 300] [--seed 7]` resets, dispatches all tasks with `landFirst: t01-null-expired` (so the premise break happens on camera) and the workload, waits until nothing is moving on three checks in a row, and saves the whole log (paged, 2,000 events at a time). `--attach` skips the reset and dispatch and saves the run in progress. The token is picked by URL: `.dev.vars` for localhost, `.env.deployed` otherwise.
- **Recording a real model's turns.** When the provider is not `scripted`, `llmFor` wraps the client (`recordingTo` in `agent/workflow.ts`, using `RecordingLlm`) and each turn is kept in the hub (`llm_turns`, keyed `<taskId>` or `<taskId>.rederive`, numbered by how many assistant turns came before, so a retried step overwrites its own turn and a second re-derive replaces the first). `POST /api/admin/llm-turns` returns them and the recorder saves them to `demo/scripts/<name>.json`. A reset clears them. **Not done:** nothing loads `demo/scripts/` back into the Worker. The stage fallback is still the generated scripts in `src/worker/agent/__scripts__/` (`LLM=scripted`), which re-run the backend for real. To replay a recorded model run instead, copy its entries over those files.
- **Compress.** A stretch of more than 4 s with no event is cut to between 1 and 2 s (whole seconds are cut, so the label is exact) and a `demo.marker` ("⏩ 2m 9s compressed") is put at the start of what is left. Events are renumbered. It is idempotent.
- **`replayDelays` changed, and its T04 test with it.** It used to skip the gap on both sides of a marker. Now it skips only the gap before one; the gap after is the kept pause, played as recorded, with the marker on screen. Without this the "cut to 1 second" in the task could not be shown.
- **Rates use real time.** A compressed log has false timestamps, so the scale view adds back what every marker says was cut (`realTimes`, via `parseCut`, which reads exactly what `formatCut` writes). Landings a minute and the sparkline are the same before and after compressing.
- **The player.** `useEventStream`'s replay half is now a position in the recording that follows a clock (`replayOffsets`, `dueBy`): it can be paused, sped up and moved without starting again, and everything that is due is shown in one step. The first version chained one timer per event and fell about 2.5× behind at 4× on the 5,000-event run; the clock cannot fall behind. Keys in a replay: Space pause/resume, → next key moment, 1/2/4 speed. Space pauses even when a strip has focus (Enter still opens it); none of the keys act inside a dialog.
- **Key moments** (`nextStop`): a marker, an agent's premise breaking, its re-derive race with a winner, a call for a person, the final metrics. What happens to scripted workload Intents is not a moment (the real run has 147 broken premises and 101 settled races, almost all of them workload). Breaks within 1.5 s of each other are one stop (three Intents going red on one landing), and what a moment causes in the next 300 ms comes with it, so a paused → shows the red strips whole.
- **`/?demo=<name>`** plays `demo/runs/<name>.json` at 1× (bundled with `import.meta.glob`, each run its own lazy chunk). An unknown name says so and plays the built-in recording. `/` still plays `src/ui/fixtures/real-run.json` at 2×; `?frame=N` still gives a still.
- **Views.** Lanes / Scale / A/B tabs are in the top bar after the wordmark, because the board has no spare height for a tab row (13 lanes need 816 of the 844 px under the bar). The ledger rail and the drawer belong to Lanes. To make room: the speed control is one button that cycles 1×, 2×, 4×, 8×; below 1560 px wide "Agents active" and "Stale, settled" leave the bar (the scale view has them); below 1400 px trunk's sha does too.
- **Scale view.** Forks created, pushes, landings a minute, agents active; landings in each 10 s as bars (counted from Intents landing, not `trunk.advanced`, because one trunk commit can carry a batch of ten); ledger contention (claims answered Wait, Split or Depend); and the cost line.
- **Cost.** Pricing read on 2026-10-09 from https://developers.cloudflare.com/artifacts/platform/pricing/ (also vendored): operations are "repo operations, such as create, push, pull, and clone", $0.15 per 1,000 after the first 10,000 a month; billing starts 2026-10-14. We count a fork per Intent and a clone plus a push per commit (the Worker clones before it pushes). Binding reads are not counted: the page does not list them. The line shows the count, the cost at the listed rate, and that the first 10,000 are included.
- **A/B panel** renders `docs/ab-results.json`: the headline, then the false-positive rate as its own paragraph before the table ("What it cost: a 76% false-positive rate. 16 of the 21 Intents that Premise turned stale would have landed on a plain rebase anyway"), then every row with its note.
- **The workload strip** now has the same anatomy as an agent's: callsign, "scripted, no model" where the status word goes, then the counts.
- **Light mode, checked with a dark system appearance** (browser emulating `prefers-color-scheme: dark`): `color-scheme` is `light only`, `data-mode="light"`, and the board, bar, Scale and A/B all stay light.
- **The recording, `demo/runs/main.json`** (deployed Worker, real Artifacts, scripted agents, 2026-10-10): 12 tasks and 300 workload Intents, 5,099 events over 4m 59s; 264 landed, 33 workload Intents gave up waiting for a claim, 0 broken builds, 0 human merges, 147 premises broken, 300 forks, 306 pushes, 53 landings a minute. 285 of the 300 workload Intents were created (15 forks did not start at that fork rate; the same thing was seen in T18). Compressing cut 6 idle stretches, 24 s in all; it plays in 4m 35s at 1×.
  - The → stops, in order: the stalemate card for T05 and T06 on `computeTotal` (20 s; it stays up for 31 s and closes by itself when T06 lands, so "Human merges" stays 0), the premise break (26 s: T02, T03 and T11 go red on `verifySession`), the three re-derive races won (57 s, 74 s, 77 s), six markers, the final numbers. **So the premise break is the second →, not the first.**
  - The agents were scripted, so no model turns were saved with it. The turn recorder is covered by tests but has not been run against a live model yet.
- **Acceptance, as run.** `npm run typecheck && npm test`: 703 passed, 4 skipped. `record-run.ts` against the deployed Worker completed (above). `compress-run.ts` cut the run and a second pass changed nothing. `/?demo=main` plays from start to finish and keeps time at 4×; Scale and A/B render the real data. Screens: `docs/screens/t23.jpg` (Scale, end of the run), `t23-demo.jpg` (third stop: T02's re-derive wins), `t23-ab.jpg`.
- **Self-critique.** Five-second test on Scale: four figures, one chart, four plain lines; nothing competes with the numbers. On A/B the first thing read is the headline and the second is what it cost. Changed after looking: the top bar clipped its counters once the view tabs went in (hence the cycling speed button and the two width thresholds); the workload strip wrapped onto two lines with three-digit counts (now the same anatomy as an agent's strip); the A/B value columns wrapped "11 text, 0 type, 0 checks" (wider now); the chart's bars were thin with wide gaps (they fill their slot now). Taken away: the separate "Scripted, not a model." sentence on the workload strip, now three words in the status slot. Polish pass over t20 to t23: the same white planes, 1 px rules, 3 px radius and no shadows everywhere; red is still only a broken premise, a failed gate or a call for a person; green is landed; blue is replay, re-derive and the workload.

## 2026-10-10: T24 notes (README, licence, run instructions, architecture diagram)

- **Files.** `README.md`, `docs/architecture.svg` (hand-written SVG, white background so it reads on a dark GitHub theme), `scripts/demo.ts` (`npm run demo`), `wrangler.local.jsonc` and `npm run dev:local`, `LICENSE` (MIT, already there; `package.json` already said MIT).
- **`npm run dev` needs a Cloudflare login even with `REPO_STORE=memory`.** The clean-clone test found it: the Artifacts binding is remote in dev, and the Vite plugin refuses to start without credentials ("it's necessary to set a CLOUDFLARE_API_TOKEN"). So the "run it with no account" path is **`npm run dev:local`**, which is `vite --mode offline` and makes `vite.config.ts` use `wrangler.local.jsonc`: the same config without the Artifacts binding, with `REPO_STORE=memory`. (Vite refuses a mode called "local", hence "offline".) There are now three Worker configs to keep in step: `wrangler.jsonc`, `wrangler.local.jsonc`, `wrangler.test.jsonc`.
- **`.dev.vars.example` is now `local.vars.example`.** T24's check `git ls-files | grep -E "dev.vars|\.env$"` must return nothing, and the old name matched it. T01 named the file; this task's check wins. Copy it with `cp local.vars.example .dev.vars`.
- **`npm run demo`** resets the Worker at `--url` (default `http://localhost:5173`), opens `/?live`, dispatches the 12 tasks with `landFirst: t01-null-expired` and starts 40 workload Intents. `--replay` only opens `/?demo=main`. `--no-open` prints the address instead of opening a browser.
- **Deploy order in the README differs from the task's list:** queue, deploy, secrets, import trunk, subscriptions, demo. Secrets go after the first deploy because `wrangler secret put` wants the Worker to exist, and the trunk push subscription goes after the import because it names the `trunk` repo. Step 2 (set `CLOUDFLARE_ACCOUNT_ID` in `wrangler.jsonc`) is extra: the value in the repo is ours. **Not tested from scratch on a second Cloudflare account.**
- **README says what was and was not run with a live model:** the recording and the A/B use scripted agents; a live model (Gemini 3.1 Flash-Lite) has run a handful of tasks including a re-derive, not all twelve at once.
- **Acceptance, as run.**
  - Clean clone into a temp directory with `HOME` pointed at an empty directory (so no Wrangler login was available): `npm install`, `cp local.vars.example .dev.vars`, `npm run dev:local -- --port 5199`, then `npm run demo -- --url http://localhost:5199 --no-open`. Output: "Reset. Trunk is trunk-mv22flgy. / Dispatched 12 tasks. T01 lands first, and breaks what T02, T03 and T11 rely on. / Started 40 scripted workload Intents (seed 7)." It settled with 52 Intents: 12 agent Intents landed, 36 workload landed, 4 workload gave up; 0 broken builds, 0 human merges, 14 premises broken, 7 stale Intents settled (one race won by the re-derive after the rebase failed). `/?demo=main` answered 200.
  - `grep -ri "merge queue\\|pull request" README.md src/ui`: nothing. `git ls-files | grep -E "dev.vars|\\.env$"`: nothing.
  - `npm run typecheck && npm test`: 703 passed, 4 skipped.
  - The README's deployed link, `https://premise.akshatdivekar.workers.dev/?demo=main`, plays; the second → lands on the premise break.

## 2026-10-10: T25 notes (video script, shot list, dry run, submission checklist, stage variant)

**Status: documents written; one acceptance step is the human's.** The script has to be read aloud once against `/?demo=main` and land between 7:30 and 9:00. Until that is done the T25 box in `PLAN.md` stays unticked.

- **Files.** `docs/video/script.md`, `shot-list.md`, `dry-run.md`, `stage-10min.md`, `end-frame.html`; `docs/SUBMISSION.md`; `scripts/serve-offline.ts` (`npm run demo:offline`).
- **The script is written against the real recording.** Every number in it is from `demo/runs/main.json` or `docs/ab-results.md`, and every key press in the shot list was tried. It is about 1,160 spoken words: 7:45 at 150 words a minute, 8:00 to 8:30 with the pauses. That is an estimate from a word count, not a timed read.
- **Order of beats differs from the recording's own order.** In the recording the stalemate card (0:20) comes before the premise break (0:26). The video shows the break first, then restarts the recording for the stalemate (shot 5: Play again, Space, →).
- **The ⏩ marker is shown after the three re-derives, not during them.** The first idle stretch in the run comes at 1:56, after T11 has landed; nothing was idle during the re-derives, so there is nothing to mark there.
- **The dispatch shot opens the real dispatch panel but does not press Dispatch.** The narration says plainly that what follows is a recording of that run.
- **What the script admits:** the agents in the recording replay recorded turns; the workload is scripted; 17% slower; a 76% false-positive rate.
- **`vite preview` is not an offline fallback.** The task suggested `npm run build && npx vite preview` for the stage. Tried with no Cloudflare login: it fails ("Failed to start the remote proxy session"), because preview starts the Worker and the Artifacts binding is remote. `npm run demo:offline` builds and then serves `dist/client` as plain files from a 40-line Node server (no dependency); the recorded run and the fonts are in the build, so `/?demo=main` plays with the network off. Checked with `HOME` pointed at an empty directory and in the browser.
- **A UI fix found while scripting:** an Intent that accepted the ledger's Split showed no "changes" chip and its drawer said "Changes nothing yet", because accepting a Split publishes no event. The reducer now takes "starts working straight after a Split decision" as acceptance and shows what the proposal left it (`reduce.ts`, with a test). T05 now shows a pencil chip for `taxFor` at the stalemate.
- **The repo has no git remote.** Publishing it is the first item in `docs/SUBMISSION.md`. Checked on Oct 10: the deployed admin token and the Gemini key are in no tracked file and no commit; the only token in the repo is `local-admin-token`, the local test value.
- **`docs/SUBMISSION.md`:** every item has an owner (Akshat; some can be done by a coding session once he says go) and a day. The proposed days are Oct 10 publish, Oct 11 dry run and timed read, Oct 12 record, Oct 13 upload and checks, Oct 14 by 6 PM PDT submit, Oct 20 stage rehearsal offline.

## 2026-10-10: the UI on phones and tablets

The user asked for the UI to look good on a phone as well as on a desktop. Before this the app had a fixed minimum width of 1280px and simply scrolled sideways on anything smaller.

- **Three layouts, chosen by window width** (`layoutFor` in `src/ui/lib/view.ts`, tested): wide (1280 and up, unchanged), medium (768 to 1279), phone (under 768). `docs/UI.md` has a new "Narrow screens" section describing them.
- **Narrow layouts do not use Kumo's Flow.** Flow puts 64px between nodes and clips what does not fit, so it cannot go below about 1280px. `CompactLanes` (in `Lanes.tsx`) is a plain list using the same `Strip` and the same bay components, with a short rule where Flow has a connector. This is a deliberate exception to "lanes are drawn with Flow".
- **Phone strip:** two lines. Callsign, stamp and status (and the race rows at the right) on the first; on the second, two chips, or one chip and a note. Long symbol names are cut with an ellipsis. `Strip` takes a `stacked` prop; the rest is CSS (`.strip[data-stacked]`).
- **The ledger is a view tab on narrow screens** ("Lanes, Ledger, Scale, A/B"). Widening the window while on it goes back to Lanes, where the rail is.
- **The drawer is a bottom sheet under 1280px** (72% of the screen's height at most), and under 768px its three columns stack and the sheet scrolls as a whole. Its sizes moved from inline styles to CSS classes so media queries can change them.
- **Human cards** are in the page's flow at the top of the lanes on narrow screens, full width. In a replay there the three buttons are in one row without their explanations (they are off anyway); live, the explanations stay.
- **Top bar, narrow:** three rows (state, navigation and player, counters). On a phone the Dispatch button is an icon with a label for screen readers, and the counters are the two hero numbers plus Landed and Premises broken. A "⏩ compressed" marker floats just under the bar so its three seconds do not shift the page.
- **Scale chart:** bars are now positioned in percentages instead of a scaled `viewBox`, so the peak label stays 12px on a phone (it had shrunk to about 5px).
- **A/B table:** value columns are 76px with 16px figures on a phone.
- **Checked at** 375×812 (lanes at the premise break, the drawer, Ledger, Scale, A/B, the dispatch panel), 768×1024, 1100×800, 1280×800 and 1440×900. No sideways scrolling at any of them; at 1280 and 1440 the page is as it was (Flow board, rail, 56px bar, nothing clipped). Screens: `docs/screens/mobile.jpg`, `mobile-drawer.jpg`, `tablet.jpg`. `npm run typecheck && npm test`: 705 passed, 4 skipped.
- **Tried and taken out:** growing the tap area of Kumo's small tabs and buttons with a pseudo-element. It made the tab lists scroll and the bar's rows uneven. The small controls are 26px tall on a phone, which is below the usual 44px guideline; using Kumo's 36px size instead does not fit four view tabs and the player on one 375px row.
- **Not done:** a layout for a phone held sideways (it gets the medium layout if 768px or wider, otherwise the phone one, and the bar then takes a large share of the height); touch has no hover, so the cross-highlight and chip tooltips are desktop only.
- **Found on the way, not fixed here:** in memory mode, restarting the dev server leaves the hub pointing at a trunk repo that no longer exists, and `/api/tasks` answers 500 until the demo is reset. Flagged as a separate task.
- **Self-critique.** Five-second test on the phone at the re-derive stop: the one red strip says "verifySession changed", its Gate bay is red, and the strip above it shows "rebase ✗, re-derive ✓" with an R1 stamp. Changed after looking: the strip's first line was centred (left-aligned now); three chips wrapped onto three lines (two on one line now); the stalemate card filled half the screen in a replay (buttons in one row); the chart label was unreadable. Taken away: the second chip when a note is showing.

## 2026-10-10: memory mode recovers after a restart; Artifacts clean-up

- **The bug.** In memory mode (`npm run dev:local`, or `npm run dev` with `REPO_STORE=memory`), the repos live in the Worker's memory and are gone whenever its code is loaded again: a dev-server restart, or an edit to any Worker file. Durable Object storage survives, so the hub still named the trunk copy the last reset made (`trunk-<time>`) and `/api/tasks` answered 500, "repo not found", until someone reset the demo. The log also still showed Intents whose forks no longer existed.
- **The fix.** `recoverMemoryStore` in `src/worker/dispatch.ts`: in memory mode, if the trunk the hub names is not in the store, or the registry has Intents and the store has no Intent fork at all, it calls `resetDemo` and starts from nothing. `src/worker/index.ts` runs it once each time the code is loaded, before the first `/api/` request is answered (a failure is logged and tried again on the next request). With real Artifacts it returns before reading anything.
- **Checked** with four tests in `dispatch.workers.test.ts`, and for real: with a stale trunk name left over from an earlier session, the first `/api/tasks` after starting the server answered 200; after a local demo (22 Intents landed) and another restart, `/api/tasks` answered 200, `/api/intents` was empty, and a dispatch landed. `npm run typecheck && npm test`: 709 passed, 4 skipped.
- **Still true:** Workflow runs that were in flight when the server stopped are not cleaned up; if one resumes after the restart it will fail on its missing fork. Restarting in the middle of a run was not tried.
- **Artifacts clean-up, at the user's request.** The `premise` namespace held 303 repos: the 300 forks of the recorded run, the original `trunk`, the reset copy, and nothing else. `POST /api/admin/reset-demo` on the deployed Worker deleted the 300 forks and replaced the reset copy; two repos are left, `trunk` and the current `trunk-<time>`. The deployed live board is therefore empty; the recorded run at `/?demo=main` does not depend on it. `wrangler artifacts repos list` shows only the first 50 repos and has no paging flag, so the Worker's own reset (which pages) is the practical way to clear a run. Three other namespaces on the account (`forkcast-demo`, 6 repos; `keepers-demo`, 8; `premise-spike`, empty) were left alone: they are not this project's.

## 2026-10-11: the Tape view, and a UX critique of it

The user picked the "tape" direction from three design mockups (a Claude Design canvas), asked for it to be built, and asked for an expert UX critique to be run on it with its suggestions applied. A critic agent reviewed the mockup; the view was then built to its findings and the built screens were sent back to it.

- **Files.** `src/ui/lib/tape.ts` (pure: `buildTape`, `spanFor`, `ticksFor`, `clock`, `positionAt`) with `tape.test.ts` (19 tests, most of them against the real recording), `src/ui/components/TapeView.tsx`, the "tape" block in `theme.css`. `docs/UI.md` has a new "The tape" section. Screens: `docs/screens/tape.jpg`, `tape-drawer.jpg`, `tape-end.jpg`, `tape-tablet.jpg`, `tape-mobile.jpg`.
- **What the critique changed from the mockup the user approved.** The mockup had capsule bars, a black trunk rail, solid blue re-derive pills, a prose legend and Geist everywhere. The critique's main points, all applied: the layout only worked at 60 seconds (now a stepped axis, and words only where they fit); status had no fixed place (now a strip-like label column); the eye went to the black rail and the blue before the red (now red is the only solid colour and trunk is a thin line); the red line crossed Intents it did not affect (now thin behind, heavy only through the rows it stopped); bars started at 0:00 and turned green when landed (now they start at the fork and stay neutral, with working and at-the-gate drawn differently); no "needs you" or failed state (both drawn); labels and tracks were unrelated for a screen reader (now one list, the story in each row's button); the phone version scrolled sideways (now marks only, no scrolling).
- **Not taken from the critique: the font.** It recommended dropping Geist for the app's existing faces. The user had asked for that font by name ("a different font that's even nicer") and approved the mockup with it, so the tape's small text stays in Geist Sans and Geist Mono. Its objections were met another way: the fonts are self-hosted (`@fontsource/geist-sans`, `@fontsource/geist-mono`, two new dependencies), callsigns stay in Barlow Condensed so an Intent's name is the same in every view, and nothing is under 12px. Changing it back is one line in the `.tape` rule.
- **Not done from the critique** (each is a known gap, none blocks the demo): paging and "Jump to now" past ten minutes (the axis just grows in 5-minute steps); stacked flag lanes and a "N landings broke premises" chip (a break without room for its words is a numbered marker instead); merging trunk ticks that are close together; a link from the landing that releases a wait; real-time tick labels on a compressed recording (labels are playback time, and each cut is a hatched gutter with a tooltip); a client-clock "now" and a dashed playhead while reconnecting in live mode; an All/Unsettled filter; an animated axis rescale; scrolling the selected row into view. Rows are 40px rather than the 36px it suggested, so with the drawer open at 1440×900 the body scrolls under the sticky header.
- **The axis follows the whole run.** At the end of the 4m35s recording the axis is five minutes and the twelve agents sit in its first quarter as marks; the workload's row carries the rest as a landings-per-5-seconds strip with red marks where its Intents went stale. An earlier version froze the axis when the agents finished; the critique was right that this hid 70% of the run.
- **Rows start when the fork is ready,** not at 0:00 (3 to 8 seconds in on real Artifacts), and the tape says "rebased", "re-derived" or "did not pass" from the race's own result rather than assuming the rebase failed.
- **Keys.** `j`/`k`, Enter and Esc work as in Lanes. In a replay the time axis is a slider (←/→ one second, Shift ten, click to move there). Those arrows are handled on the slider and do not also trigger the page's "next key moment".
- **Fixed on the way:**
  - After a tab was clicked it kept keyboard focus, and Kumo's tabs took the → key, so "jump to the next key moment" silently did nothing until something else was clicked. A pointer click on the tabs now gives focus back to the page; keyboard users of the tabs are unaffected. **This affects the video shot list** (shots 1, 2, 7 and 9 click a tab and then use →): it now works as written.
  - The "⏩ compressed" marker sat inside the top bar and squeezed the counters for its three seconds. It now floats under the bar at every width.
  - A counter could flash a negative number for one frame while rolling (the first animation frame's timestamp can precede the start time). Progress is clamped.
  - `--amber` was 4.43:1 on white, just under AA for text; it is now `#8F5B0E` (5.7:1). `docs/UI.md`'s token table is updated.
- **Checked** at 1440×900 (0:56, end of run, drawer open, flag chosen, slider keys), 768×1024 and 375×812: no sideways scrolling, top bar not clipped. `npm run typecheck && npm test`: 728 passed, 4 skipped.

### The critic's second pass, on the built view (same day)

It read the built screenshots and code and reported the view now does its job ("at 0:56 the red flag is the loudest thing on screen and the three stopped rows read in one glance"), would not insist on any of the gaps listed above, and found these, all applied:

- **The tape hid a moment when a person was asked.** T05's stalemate card (0:20, never answered) did not appear on it at all. `buildTape` now reads `human.needed` and `human.resolved`: a bell on the row at that time (solid while the ask is open, hollow once it is over), a bell in the label column while open, and the row's summary and the live region say what was asked and whether anyone answered. The solid red bar is still only for `escalated`.
- **Arrow-key seeking stalled** wherever no event fell inside the next second (46 such stretches in the recording, up to 3.9 s). A step now always moves at least one event in its direction; Home and End go to the ends.
- **The end frame was louder than the story:** six full-height hatched gutters and solid green blocks. Cut time is now a hatched mark on the trunk line only, with a key item giving the total ("idle time cut from the recording (24 s in all)"), and the workload's density bars are a tint with an outline.
- **The "⏩ compressed" pill covered the tape's playhead.** It is not shown on the Tape view, which marks cuts itself.
- **The break drew itself in every time the tape was opened.** The draw-in and the fade-in of "premise broke" now run only when the break is less than 1.5 s old.
- **The generated sentence was in the footer,** out of sight with the drawer open. It is under the flag lane in the sticky header. Clicking anywhere on a row's marks selects the row.
- **Smaller:** a row is marked as hit even when it went stale more than 3 s after the landing (its bars then keep their true times); flags are fitted in pixels in the view, not by a share of the axis; the tablet's workload label shows two counts, with the rest in its tooltip; the selected row is scrolled into view.
- **Counters:** it saw the top bar disagree with the tape in screenshots (0 landed beside "15 landings", and a "-8"). The numbers in the page were right; the screenshots caught the rolling animation, which depends on animation frames the preview pane does not always deliver. Hardened anyway: a change of more than 5 is shown at once, progress is clamped, and the number is set to its final value after 400 ms whether or not a frame ever ran.
- **Also changed:** on the Tape view a human card sits above the tape at every width, because floating at the top right it covered "now".
- `npm run typecheck && npm test`: 731 passed, 4 skipped.

## 2026-10-10: an automatic draft of the video

At the user's request a background agent tried to produce the video with nobody at the keyboard, and did: `video-out/premise-demo-draft.mp4` (git-ignored), 8:18, 1440×900, H.264 with an AAC narration track. `video-out/README.md` says how it was made and `sh video-out/make.sh` re-runs it in about eleven minutes (with `npm run demo:offline` running).

- **How.** `playwright-core` drives the installed Chrome headless through `docs/video/shot-list.md` against the offline copy and saves Chrome's own screencast frames; macOS `say` (voice "Daniel") reads the script one sentence at a time, so the clicks follow the voice; a small Swift program joins frames and sound with AVFoundation, because **ffmpeg is not installed on this machine** and was not added. Nothing was installed system-wide or in the project. The recording made no non-GET requests; it reads `/api/tasks` once from the deployed Worker so the dispatch panel can list the tasks.
- **It is a draft, not the submission.** The voice is synthetic; the end frame says `github.com/OWNER/premise`; shot 8 shows the two functions on a plain page, not in an editor; there is a 10-second silence before the premise break while the replay catches up. Nobody has watched it play: the agent checked stills and measured the sound.
- **Two things in the shot list were wrong at 1440×900, and are corrected there:** the stalemate card covers the ledger's `verifySession` row at the premise break (shot 3 now hovers the struck chip on T02's strip, which lights the same strips), and the drawer cannot show Asserted, Derived and Observed at once (shot 6 now scrolls the column).
- `premise-demo-draft-review.mp4` is the same video at 1152×720 and a lower bitrate (about 21 MB), made to fit a 30 MB sending limit.

## 2026-10-11: four reviewer judges, and what changed because of them

At the user's request four reviewer agents graded the project against the official criteria (originality and quality 50%; concurrency, coordination, context, review and conflicts 25%; ease of use 25%), told to be harsh. Weighted scores: platform lead 3.5, agent-infra skeptic 3.4, UX and demo 3.75, originality 3.63. They agreed on the main faults: the A/B baseline ran no tests, so the headline measured the scenario; the one behavioural premise was adopted on a task hint; the agent wrote the tests it was gated on; there was no way to review an Intent's work; and several docs claimed more than the code did.

### Changed

- **The gate runs more (`src/worker/gate/gate.ts`, `suite.ts`).** Besides the Intent's own tests and assertions, every landing now runs the task's **reference checks** (every test in `premise/hidden-tests/<task>.test.ts`, from trunk's own copy; work that changes that file does not land) and **every test already on trunk** under `tests/`. A batch of workload Intents runs trunk's suite once. `run_checks` runs trunk's suite too, so an agent hears before the gate; it does not see the reference checks.
- **`src/shared/types.ts`: `GateReport` has two new optional fields, `reference` and `suite`.** Changed outside a task because the gate's report had nowhere to say what else it ran. Optional, so old recordings still read.
- **A landed Intent's reference checks stay standing** with its own tests. They apply only on a trunk that has that Intent's own test files, because a reference file is on every copy of trunk from the start and an agent whose fork predates the landing could not pass them.
- **A third A/B rule, `queue`:** rebase, typecheck, the change's tests, its reference checks and trunk's suite; no ledger, premises, standing checks or re-derive. `RunMode` is now `premise | baseline | queue`. The report (`src/worker/ab/report.ts`) has three columns, takes several seeds and gives the lowest and highest value where they disagree, splits false positives between agents and the scripted workload, has a symmetric row for work that did not land, and has a section saying what the scenario builds in. `scripts/ab.ts --seeds 7,11,23`.
- **The scenario now has the case tests miss.** `demo-repo`: `guardRequest` takes an optional `verify` in its deps (default `verifySession`). T11's tests (and so its reference checks) use a stand-in verifier, so after T01 they still pass; only the assertion fails. `premise/probes/` is new: end-to-end checks that no rule runs before landing and that count as regressions when red (`src/worker/ab/regress.ts`). `scripts/check-scenario.ts` proves all of it (43 outcomes). The re-derived T11 handles a verifier that throws and one that returns null.
- **No task hint names an assertion any more,** and the scripted agents write theirs inline instead of adopting `a-session-throws` from `premise/assertions.json` (the library stays, as a feature and for tests). T01's "do not assert" hint is gone too; instead **an assertion about a symbol the Intent then declares it will change is withdrawn** (`withdrawOwn` in `src/worker/intent/premises.ts`), which is the general fix the Oct 10 note said was not built.
- **Every plan is asked what behaviour it relies on.** `declare_changes` refuses once if the agent has asserted nothing and has not passed `no_behaviour: true`. `assert_premise` now reads import statements in the code for what they mean (`src/worker/agent/assertion-input.ts`), rejects a check that calls no function from the files it imports, and explains syntax errors. `PLAN_TURNS` is 16.
- **Ledger.** A Split is only offered when exactly one other Intent is in the way; with two or more it is Wait. Before, a three-way overlap could hand the requester a symbol the third Intent held, silently. Claims are renewed before every work turn (`renewEverywhere` had no caller).
- **Re-derive.** An attempt voided by a further change to trunk is free twice, then counts as a failed re-derive, so it ends with a person (`MAX_FREE_VOIDS`; the state machine allows `stale → escalated`). A **type-surface change no longer voids a re-derive in progress**: the gate checks the result against trunk as it is by then. A broken assertion still does. A run's `hold` (the planted change lands first) now also holds on the re-derive path; before, a held Intent that went stale early could land its rebase ahead of T01.
- **Review.** `GET /api/intents/:id/diff` and a Changes column in the drawer. `record-run.ts` saves each agent's diff into the recording (`{ events, diffs }`; a recording without diffs is still a plain array; `src/ui/lib/recording.ts` reads both).
- **Public API.** An Intent id is checked for shape and against the hub's registry before any Durable Object is touched; `/api/tasks`, `/api/trunk` and pushed diffs are cached for five seconds; the hub refuses more than 200 sockets.
- **UI.** A caption under the top bar in a replay says in one sentence what the screen shows (`captionAt`), and there is a "Next moment" button. `/` plays the main recording. Speeds are 1, 2, 4. Status words have tooltips. Chip tooltips are in the third person and use callsigns. A failed assertion is named by its description, not its id. "Race" is gone from the copy (the rebase is tried first; that is not a race). In a replay a stalemate is one amber line in the page, not a red card over the board. The ledger says "Nothing in flight" only when that is true. The A/B tab has three columns and hides the replay's counters.
- **Docs.** README rebuilt (problem and link first, the three-rule table with what it does and does not show, "Where this comes from", "What a model does on its own", a longer limitations list, deploy steps folded away). SPEC: the self-awarded panel grades are removed and "As built" notes mark where the build differs. SUBMISSION: the video is a file upload, a person submits the form, drafts of the three form texts. The video script is rewritten to about six minutes.

### Measured

- **Three rules, three seeds, local Worker with in-memory repos** (`docs/ab-results.md`): typecheck only shipped 3 regressions; the queue with tests shipped 1 and sent 2 of 12 tasks back; Premise shipped 0 and sent 0 back, on every seed. To be re-run on real Artifacts.
- **Does a model assert unprompted?** Gemini 3.1 Flash-Lite, tasks t02, t03 and t11 at once, no hints, `LIVE_LIBRARY=off` where it says so, in the live harness:
  - Library visible: 3 of 3 adopted `a-session-throws`.
  - No library, no question at `declare_changes`: 0 of 3 asserted anything.
  - No library, with the question, final protocol (two rounds): 2 of 6 wrote a correct assertion about `verifySession`; the other four asserted something else or nothing. All 6 submitted and passed the reference checks.
  - On the way (earlier protocols, not counted above): the question alone made all three name the right premise, and two then failed on writing imports inside the code; fixed. One wrote `assert.throws(() => { throw new E(); }, E)`; such checks are now rejected. One asserted about the function it was changing and blocked itself; such assertions are now withdrawn.

### Not taken, and why

- **Hiding the `hints` field of `/api/tasks`** (suggested so a viewer would not see the hints). Not done: the fix was to remove the hints, not to hide them.
- **Making Depend re-fork the waiter.** Not built. The README says what Wait and Depend do.
- **At-least-once invalidation with a dead-letter queue, and creating the Queue subscriptions.** Not done; the README now says the Queue path has not been exercised on the deployed Worker.
- **Keeping `.intent/<id>.json` on trunk** so premises live in Git history. Not done.
- **A public, rate-limited live run for judges.** Not done: it would spend the model quota and Artifacts operations of anyone who found the address.
- **Removing the old built-in fixture and the Replay/Live toggle, the trunk sha, and counters from the bar.** Left; `/` no longer plays the fixture.
- **A scripted delay so the recording shows an agent stopped mid-work.** Not done: it would be staging. The script no longer says the three were stopped "before the gate".

### Still open

- **Deploying and publishing were not done in this session.** `scripts/publish-demo-repo.sh` and `npm run deploy` were refused by the session's permission check, and need the user's go-ahead. Until then the deployed Worker runs the Oct 10 build, the A/B numbers in the README are local ones (it says so), and `demo/runs/main.json` is the Oct 9 recording (the README says what differs). After deploying: re-run the A/B, re-record, and update the numbers that depend on the recording (README, `captionAt` and tape tests, the script's "read it off the tab" rows). The steps are at the top of `docs/SUBMISSION.md`.
- **A recorded run with a live model** (`/?demo=live`) is not made.
- **Scripted re-derives write whole files from a fixed script,** so a re-derive whose file the workload also edited silently drops the workload's edit. A real agent reads the current file. Found while reading the three-seed results; not fixed.
- **One test is timing-sensitive:** `standing.workers.test.ts`, "t02 lands, then t01 is stopped…", reads the events right after the status turns `escalated` and once saw no `human.needed` yet. It passed on every later run.
- `npm run typecheck && npm test`: 833 passed, 4 skipped.

### Later on Oct 11: deployed, measured on Artifacts, and a smaller front page

- **Deployed and published,** on the user's go-ahead ("Let's push"): `scripts/publish-demo-repo.sh akshat12/acme-accounts`, then `npm run deploy`.
- **The three-rule comparison on real Artifacts** (seeds 7, 11, 23; `docs/ab-results.*`): 3, 1 and 0 regressions and 0, 2 and 0 of 12 tasks sent back, on every seed, the same as locally. Artifacts refused some forks under load (one run got 93 of 112). These runs were made before the ordering hold covered the workload, so in them a workload landing could precede T01; the report's sentence about the hold describes the build as it is now.
- **Two words, at the user's request:** the *screen recording* is the video; a *demo recording* is a saved run from Cloudflare that the site replays. Never bare "recording".
- **The front page is now four agents** (T01, T02, T04, T11; no workload; about a minute), chosen by the user from three options because it is the easiest to follow. One cause, three outcomes: T02 is caught by its tests and its premise, T11 by its premise alone, and T04 (the control) is untouched because it relies only on types. `demo/runs/main.json`.
- **The larger run is `demo/runs/scale.json`** (twelve agents, 294 workload Intents, 309 forks, 266 landed, 4:20). The Scale tab shows its end state with a note saying so and a link to play it (`/?demo=scale`), whenever the front-page run is the one playing.
- **The Oct 9 demo recording is now a test fixture,** `src/ui/fixtures/run-2026-10-09.json`. The tape and caption tests were written against it and still read it; new tests cover the four-agent story.
- **`record-run.ts --tasks t01,t02,t04,t11`** dispatches a subset.
- **The ordering hold** now covers everything that is not one of the Intents being waited for, by id. Two earlier versions leaked: holding by kind missed a workload Intent whose kind was a guess (its Intent could not be read when it was queued), and before that the workload was not held at all, so its type changes turned held agents stale before T01 landed.
- **The `→` key no longer stops at "⏩ compressed" markers.** With four stops in the whole run, two extra stops for cut idle time got in the way. The marker still shows, at the end of the caption's line.
- **The break's caption names the control:** "T04 SESSION read it too, but relies only on its type, which did not change."
- **A bug in the scripted workload runner, fixed:** when a premise broke between two of its steps, the runner's next step threw and it marked the Intent failed, although the gate was already rebasing it. 7 of the 40 workload Intents that did not land in the larger demo recording went this way; the README says so.
- **Not re-run:** the A/B after the hold change (the headline rows do not depend on it), and the clean-clone check of the README's local steps.
- **A demo recording with a live model,** `demo/runs/live.json` (`/?demo=live`): the four front-page tasks on the deployed Worker with Gemini 3.5 Flash-Lite, no hints. 419 s, 4 of 4 landed, no person. All four adopted `a-session-throws` from the library. T01's was withdrawn when it declared its change. T11's rebase passed its own tests (the model wrote them with a stand-in), the reference checks and trunk's suite, and failed only on the premise: the case tests miss, with a model's own tests. T04, the control, adopted the assertion too and was stopped and re-derived for nothing. T01 was quarantined for two tenths of a second ("edited without a claim") and let through by the automatic upgrade. The model's turns are in `demo/scripts/live.json`. The agents were switched back to scripted afterwards.
- **Captions:** a re-derived Intent that was stopped before it had pushed is described that way, not as a rebase that failed. The live run's opening caption says it is a live model and how much waiting was cut.
- **The automatic video draft is gone.** At the user's request `video-out/` (the Oct 10 draft and the scripts that made it) and its work files were moved to the Trash. The draft followed the old eight-minute script and the old demo recording. The Oct 10 note above describes how it was made, if it is ever wanted again.

### Oct 11, evening: the front page becomes a story on the tape

- **Why.** The user said the UI was still confusing for someone new, that the tape was the view they could follow, that its bars stuttered as they moved, and that the Lanes view could go. Three directions were mocked up on the design canvas (guided tape, threads, story beside the tape); the user chose the guided tape and asked whether it would hold for sixteen agents.
- **What was built.** `src/ui/lib/story.ts` turns an event log into steps (`storyFor`): the start, what each relies on, the landing, who was stopped, what became of each, the end. It names agents "Agent 1…N" in task order. `StoryBar.tsx` shows one step at a time with Back, Next and Play. `TapeView` has three row sizes (`densityFor`: up to 6, up to 16, more), plain labels with what each changes and relies on, a focus from the step, an end note ("not affected"), and a callout of what the gate ran when every test passed. `SimpleBar.tsx` is the replay's top bar. `Lanes.tsx` and `LedgerRail.tsx` are deleted; `docs/UI.md` has a new first section saying what supersedes what.
- **Sixteen agents.** Rows shrink by count, and with more than three stopped agents the story groups them by outcome, so it stays at about seven steps. Tested on the twelve-agent recording (8 steps); not yet looked at with sixteen on screen.
- **Next runs the tape.** A step forward plays the replay to that place at whatever speed takes about a second (capped at 40×) and holds there: the replay source takes `until`, and its clock stands still while held. Back seeks.
- **The stutter.** The tape used to move only when an event arrived. `useEventStream` now exposes its clock; `timeAtClock` turns a reading into the tape's time, and `advanceTape` grows the open bars each animation frame. In a replay the axis is fixed for the whole run (`buildTape(…, total)`), so it no longer changes scale mid-play.
- **Words.** The status "stale" reads "stopped" on screen. Callsigns are no longer shown in a replay. One product word is introduced per step.
- **The live-model run let a regression through, and the docs said otherwise for an hour.** Checking the story's last step for that run showed `behaviouralRegressionsOnTrunk: 1`: Gemini's redone T11 was the same edit as the one that was stopped, with a weaker assertion, and it passed every test. The README, the story's last step ("One problem reached trunk") and the video script now say so. Nothing yet checks that redone work differs from the work that was stopped, or that it no longer rests on the premise that broke. That check is the obvious next piece of work on the gate.
- **The details panel** can be dragged taller or shorter by its top edge; a double-click puts it back.
- **Removed at the user's request:** `video-out/` (the automatic draft). **Not removed:** Artifacts repos in other namespaces; the user was given the commands.

## 2026-10-12: a second live-model run, and what a re-deriving agent is asked

- **The gate check from Oct 11 was not what the second run needed.** `sameAsStopped` (a redo identical to the stopped work is turned back) is deployed. The four tasks were run again on Cloudflare with Gemini 3.5 Flash-Lite (`demo/raw/live2.json`, model turns in `demo/scripts/live2.json`). Four landed in 391 s; the run again ended with `behaviouralRegressionsOnTrunk: 1`, from T11. T11 was stopped while still working, so it had pushed nothing to compare the redo with.
- **What the model did on the redo.** It read the new `verifySession`, tried to adopt `a-session-throws` again, was refused ("does not hold on the current code"), passed `no_behaviour: true`, and wrote the catch-block code with a stand-in test that throws. Own tests, reference checks and trunk's suite passed; it held no asserted premise.
- **Bug found: the briefing offered an assertion that was no longer true.** `premise/assertions.json` on trunk still lists "verifySession throws" after T01 lands, and the briefing listed it for the redo. `holding()` in `agent/tools.ts` now runs the library on the fork and the briefing offers only what passes.
- **New rule in `declare_changes`.** In a re-derive, for each asserted premise that broke (`ToolContext.broken`, from the run's `broken` parameter), the plan is refused until the Intent holds an asserted premise on the same symbol, unless it is now changing that symbol. `no_behaviour: true` does not answer it. The refusal (`askAgain`) quotes the old premise and what that check reports on today's code. Pure part: `unanswered()`. The scripted re-derives already assert the new behaviour, so recorded runs are unaffected.
- **Measured locally, not on Cloudflare.** `live.workers.test.ts` gained `LIVE_REDO=1` (trunk after T01, the Intent told its premise broke) and a `probe` verdict. T11, three runs, Gemini 3.5 Flash-Lite: every run asserted something about `verifySession` (the right thing once, "returns null for an undefined token" twice). One passed the probe but failed a reference check; one failed both; one passed the reference checks and failed the probe, which is the case that would land wrong.
- **Why the hole stays open.** T11's hint tells the agent to test with a stand-in, and its reference checks use a stand-in that throws. That is the scenario's point on the first attempt (only the premise can see the break), and it means that on a redo nothing but the agent's own reasoning connects the new premise to the code. A true premise with wrong code lands. The README says so.
- **Not done.** The two changes are not deployed and there has been no third live run. `/?demo=live` is still the Oct 11 run; the README dates both runs.
- **Design canvas.** Board G restyles the guided tape after a reference the user sent (mono uppercase labels, light numerals, hairlines, one orange accent). It is a mock; the app is unchanged until the user says so.

### Oct 12, later: deployed, and the instrument look

- **Deployed** the agent changes above (Worker version `f0323a21`), at the user's word. Still no third live run.
- **The look.** The user approved board G. `theme.css` tokens, type and the tape's marks were restyled; `docs/UI.md` has a new first section that supersedes its Type and colour notes. No layout or behaviour changed, with three additions: the counter strip (`RunFigures.tsx`), "Replay of a recorded run" in the replay's top bar, and the gate readout as four readings.
- **Fonts.** Geist Sans 300 and Geist Mono 400 were added to the imports; both packages were already approved. `@fontsource/barlow-condensed` and `@fontsource/ibm-plex-mono` were uninstalled, as nothing uses them now.
- **`--redpen` kept its name** and changed its value to `#c2410c`, because the name is in dozens of places and in this file's history. It is the accent; `--accent-line` is its brighter form for lines and dots, which must never carry text (3.5:1).
- **Kumo's primary button** takes its colours from `--color-kumo-brand` through inline variables, so `.story-controls` sets that variable to ink.
- **A crowded flag** (the next break lands under its words) is written to the left of its line when there is room. In the twelve-agent recording there is not, so the second break's numbered marker sits on the first flag with a ring round it. Known and left.
- **Counter strip wording.** "Premises broken" is the log's own count, so in the larger run it includes the scripted workload's (28 at step 5). "Problems on trunk" is behavioural regressions plus broken builds; it shows 1 for the live-model run.

## 2026-10-12, afternoon: an audit by four reviewers, and what it changed

The user asked what was still wrong. Four read-only reviews ran in parallel (a clean-clone run of the README, docs against code, the Worker, the UI) and the screens were walked by hand. What follows is what was found and done; each item was checked by a test or in the browser.

### The gate and the agent (types.ts changed: `Intent.stopped`)

- **A redo the gate turned back as "the same as the stopped work" landed a moment later.** The check was only on the re-derive path; the next race tried the same commit as a plain rebase, which had no such check. `startRace` now asks `redoneTheSame` first and skips the rebase.
- **What a redo is compared with is now recorded, not guessed.** `Intent.stopped = { work, over }` is set in `startRace` when a premise the Intent had asserted broke: `work` is the push that was stopped (null if it had not pushed), `over` the premises. It is kept across later attempts. Before, the comparison was with "the attempt before", so a scripted agent's second re-derive (always the same files) was turned back and only landed through the bypass above. Closing the bypass alone would have sent those to a person. This is why `src/shared/types.ts` gained an optional field.
- **Known cost.** Work that was right all along, stopped over a premise it did not need, and redone identically, is turned back; after two tries a person is asked. In the README's limitations.
- **The redo rule is asked again on later attempts** (it used to lapse after the first, because the broken premises are cleared at restart), is answered by an assertion that *calls* the symbol whatever it is filed under (it used to depend on the order of `imports`), and is not asked about a symbol that is gone.
- **`assert_premise` checks a `symbol` the agent names:** a real id, an exported symbol, in a file the check imports and mentions. A malformed id used to be stored and then break `land` and `fail`.
- **Landings by rebase were never measured for regressions** (`afterLanding` was not called from `race()`). It is now. The committed A/B was run before this; in it 0 or 1 agent Intent per seed landed that way, so its Premise column may have watched one task fewer than the other columns. Not re-run yet.
- **Steps that are retried carry on.** `record-push`, `hand-off` and the checker used to give up when an earlier try had already moved the Intent to `submitted`, `checking` or `queued`, which could strand it, and if it was the Intent others were held behind, hold the gate for good.
- **After a landing nothing may be lost to one failed call.** The work is on trunk, so the status, the standing checks, the events and invalidation are each tried up to three times and logged if they still fail, and the rest go on (`gate/persist.ts`). Invalidation retries its reads and tells each Intent separately.
- **The event log drops events about Intents it never saw created,** which is what a run still finishing after a reset produces. `ctx.base()` no longer keeps a failed read. `GATE_VERSION` is 7.
- **Not done:** `landing.hold()` is still called after the agents are started (not reproduced as a problem); per-Intent Durable Objects and Workflow instances are still never deleted.

### The local run (`npm run dev:local`, `npm run demo`, `npm test`)

- **`npm test` failed on a fresh clone,** always on the first run: `health.workers.test.ts` read whatever trunk the files before it had left (t01 landed). It now resets first. The `retry` added an hour earlier was a wrong diagnosis and is gone.
- **The local Workers runtime can crash when given a run in its first seconds.** It dies while logging "An RPC stub was not disposed properly". `ports/release.ts` now disposes the stubs we hold (Workflow instances, the Dynamic Worker and its entrypoint), and the workload creates instances one at a time locally, because the local binding's own `createBatch` leaks one. **Both warnings still appear once per start,** so something still leaks (in our agent path or in the local Workflows engine; not found). So `scripts/demo.ts` waits for a just-started local server (the Worker reports how long it has been awake in a header on `/api/health`) and starts the run once more if it fails. Eight immediate starts in a fresh clone: the demo finished every time, the runtime restarted in four.
- **A local A/B no longer overwrites the committed results** (it writes `docs/ab-results.local.*`). `package.json` has `engines` (Node 22.12+ or 24).

### The screen

- Each replay says what kind of run it is ("Replay · scripted agents · real Artifacts", "Replay · live model · real Artifacts"); the live-model run also says so in its first step.
- A row says what its Intent relies on *now*: not a premise it withdrew, and not one that broke and was never restated once it has landed.
- Playback: a seek while playing is no longer undone; the button goes back to Play at the end; "No Intents in flight" no longer flashes in a replay; Space and the arrows are the story's only on the story view.
- Counters are counted from the events, not from the periodic metrics, which trail them. "Re-derived" no longer includes plain rebases.
- The row a step is about is scrolled into view on a short window; the gate readout is two by two on a tablet.
- Words: "stopped", "did not land" and "needed a person" are used throughout, including the comparison table (re-rendered from its stored trials, nothing re-run). The table's "turned away" range was wrong (0 to 2 checks; the data says 0 to 3): `spread` ordered a three-number cell by its first number.
- "136" on At scale was ledger answers, not collisions: it now reads "36 Intents … 136 times".
- Dead code from the strip board is gone: the `Strip` component, the chip, bay and ledger helpers in `lib/view.ts`, `sharedSymbols`, and about 210 lines of CSS. `Strip.tsx` keeps the marks other views use.
- Not done: `HumanCards`' floating variant and `ViewState.ledger` are still there, unused by any view.

### Documents

- The video script said the gate "does not yet check that redone work is different"; it does, and the row now says so and what the second live run showed. The script is 875 words, about 6:20 with pauses; the live-model row must not be dropped (without it the read is under five minutes).
- README: T11's hint to test with a stand-in is stated; the three local redo runs are described as they went (none would have landed right); the smoke command, the subscription caveat, two limitations and the test count are corrected.
- The dry-run checklist, shot list and stage notes are rewritten for the story page. `CLAUDE.md` still describes flight strips and a race; it is the user's file and was left.

### Later the same afternoon: an independent check before deploying, and what it broke

The user asked for a separate agent to verify the batch before it went to Cloudflare. It worked in a fresh clone and tried to break each claim. Its verdict was "not ready": the ordinary path was sound (cold `npm test` 887 passed, the demo finished in four of four fresh starts, the A/B test and the scenario check unchanged), but three claims failed when a single call failed. Its tests are now in the repo as `gate/failure-paths.test.ts` and `gate/failure-paths.workers.test.ts` (26 tests), and all pass.

- **The redo check failed open.** A failed read of the stopped fork was caught and taken as "different work", so the turned-back commit landed. `redoneTheSame` now retries its reads and throws if they keep failing. At the gate that leaves the Intent queued for another try; in `startRace` it means no rebase, and the work is redone.
- **"The same work" was whole-file equality,** which called a redo that dropped one of two files "the same", and missed the identical edit when the landing in between had touched that file. `sameAsStopped` now compares the redo with the stopped work carried onto the new trunk by the same three-way rebase the gate uses (`Intent.stopped.work.base` records where the stopped work started). A file that cannot be carried is compared whole.
- **`record-push` still gave up on a retry:** the check added earlier sat after `takenOver`, which reads a first attempt that is already `submitted` as taken over. It is first now. A hand-off retried after the checker had quarantined the Intent asks the ledger again instead of doing nothing.
- **Invalidation could lose a stale Intent** when `breakPremise` did its work and lost its answer (the retry says "nothing new broke"). After a failed try, an Intent that is stale counts. No read after the commit is claimed can throw any more; a read that keeps failing is logged and the rest goes on.
- **The batch landing had none of the protection the single landing got.** It has it now.
- **"About a symbol" matched a name in a comment, or a method of the same name on something else.** Comments are stripped and a leading dot rules a match out (`callsFunction`, `withoutComments`).
- **Known and left:** if marking an Intent landed fails on all three tries, its work is on trunk and it stays `gating` (logged). The steps a caller runs after `landWork` returns (`queueStale`, `afterLanding`) are not retried. Only the latest stopped work is remembered. Three scripted "why" lines say "in the catch branch", the code sense of a word the UI vocabulary rule bans; they are in the recorded runs and were not edited.

### The verifier's second pass

Every failure from the first pass was confirmed fixed. Two things came back.

- **A regression from the fix above.** Ruling out a leading dot also ruled out `session.verifySession(...)`, which is what an assertion written with `import * as session` becomes. Such an assertion was no longer withdrawn when its agent went on to change the function, so its own change broke its own premise and it could never submit. A call through a namespace of the import counts again: `callsFunction` reads `const ns = { a, b }` as a namespace. An arrow-function property of the same name on some other object does not count; a method written with method syntax, or a function the check declares itself under that name, still does, because the match is by name (the third pass showed this; it is in the README's limitations).
- **The identical edit next to the landing's change was called different,** because neighbouring lines are a conflict for the three-way merge and the fallback compared files whole. For a file that cannot be carried, the edits themselves are now compared: the same lines out and the same lines in, wherever they sit.
- Its second-pass tests are kept too (`gate/break-attempts.test.ts`, `gate/break-attempts.workers.test.ts`, `gate/namespace-assertion.workers.test.ts`). `npm test` from a cold cache: 941 passed, 4 skipped. `GATE_VERSION` is 8.
- **Listed by the verifier as acceptable to ship with, and left:** steps a caller runs after a landing returns are not retried; an Intent whose "landed" mark fails three times stays `gating` with its work on trunk; a first-attempt Intent whose `breakPremise` answer is lost three times is stale and never queued; a card for an Intent whose stopped fork cannot be read says it "does not pass its acceptance checks" before giving the true reason; a name inside a string still counts as a call. Intents stopped before this deploy have no recorded base and keep the whole-file comparison, which a demo reset clears.

### Deployed, and the third pass

- The verifier's third pass on `4478e00` said ready: cold `npm test` 941 passed and 4 skipped, its earlier tests still green, no regression from new break attempts. That commit was deployed (Worker version `8e79abae`); `/api/gate` reports version 8.
- **After the deploy, one change it recommended:** an assertion written through a namespace import was filed under the first export the namespace lists, so a break asked the redo about the wrong symbol. `assertionSymbol` now uses `callsFunction`, which sees the namespace call.
- For about fifteen seconds after a deploy a request for the new stylesheet can be answered with the page itself (the single-page fallback), so the page comes up unstyled until reloaded. Do not deploy while someone is being shown the site.

### The comparison, run again on the deployed build (Oct 12, evening)

- **Why.** The committed numbers were from Oct 11, before the hold covered the workload and before rebase landings were measured for regressions. Running it again also put the day's gate changes through about a thousand real forks and landings.
- **Result** (real Artifacts, n = 100, seeds 7, 11, 23, Worker version `8e79abae`): the headline rows are unchanged. Regressions 3 / 1 / 0; tasks sent back 0 / 2 / 0 of 12; stopped Intents redone and landed 0 / 0 / 3; broken builds 0 / 0 / 0. In Premise mode all twelve tasks landed on every seed, no re-derive failed, nobody was asked.
- **What moved.** Wall time is longer in every mode (115 to 126 s, 130 to 153 s, 156 to 188 s; it was 85 to 90, 79 to 91, 103 to 145), most likely because every landing now waits for the planted change. Workload Intents that did not land: 11 / 11 / 11 to 15. No agent Intent landed on a plain rebase this time (it was 0 or 1), so the measurement gap did not arise. Forks per run: 107 to 112.
- **A second slip of the same kind in the table:** the false-positive rows are shares ("100% (19 of 19)"), and three runs at 100% were left in the order they were made, so the range read "14 of 14 to 19 of 19" when one run had 25. `shareCount` orders them by the count. Re-rendered from the stored trials.
- The Oct 11 results are not kept in the repo; `git show 35ef6d6:docs/ab-results.json` has them.

## 2026-10-12, evening: two tabs, and a run anyone can start

Asked for by the user after trying the site on a phone: the "At scale" and "Compared" tabs were confusing next to the Replay/Live switch, and the idea was one Demo tab and one Live tab "which naturally runs in real time". This reverses the Oct 11 decision above ("A public, rate-limited live run for judges. Not done"): the objection then was the cost to anyone who found the address, and the answer now is that a public run is scripted only and its limits are few and tested.

### The page

- **Two tabs: Demo and Live.** Demo is the recorded run as a story, as before. The comparison and the larger run are no longer tabs: they are two panels under the tape, in the same scrolling area, Compared first. The story's last step says they are there and that the Live tab runs it for real. `TopBar.tsx` (the live board's own bar, with its counters and trunk commit) is gone; both tabs use `SimpleBar`, and the counter strip under the sentence does the counting in both.
- **Live has the story bar's shape with one button where Back and Next are.** `src/ui/lib/live.ts` (pure) chooses the sentence: the latest step `storyFor` can make from the live log, and the story's last step only once the run is over. Agents are "Agent 1" to "Agent 12" here too.
- **Found by the tests, and fixed before anyone saw it:** for about a second after the last Intent lands, the log has its "landed" status but not yet the events that say how it got there, and a summary written then says "Agent 4 did not land". The run is summed up only when every Intent is at rest and the log has been silent for 1.5 s (`runSettled`). In a live run the sentence about work that passed every test and was still wrong can be on screen only briefly, so the summary says it once more.
- **A card that asks a person** is one amber line on the Live tab unless the admin token has been typed in: a visitor has nothing to answer it with.

### The run anyone can start

- **`POST /api/live/start`: no token, no parameters, the body is not read.** It does what `npm run demo` does: a reset, the demo repo's twelve tasks with the planted change held to land first, and a scripted workload of 30. It runs as an instance of the existing `AgentWorkflow` class (a third kind of params, `mode: "public-run"`), so it outlives the request and needs no new binding or migration. `GET /api/live` says whether one may start.
- **The limits are in `src/worker/live/public-run.ts`, pure, and applied in one turn of the EventHub** (`claimPublicRun`), so of any number of simultaneous requests exactly one is accepted. One run at a time; three minutes between starts; forty starts in any 24 hours; refused while the agents' provider is not `scripted`; a switch, `POST /api/admin/public-runs { enabled, clear? }`, that needs no deploy and survives a reset. `clear` gives the day's starts back.
- **"A run is in progress" is read from the board, not from who started it:** Intents not at rest (landed, failed, escalated, quarantined), or the gate busy. A run with no event for three minutes, or still unfinished fifteen minutes after its reset, is taken to be stuck and no longer blocks a start.
- **A reset says it has begun before it clears anything** (`EventHub.resetBegun`, called first in `resetDemo`). Until the hub's own reset, the board shows the run before at rest, which is exactly when a public start would be allowed; without this a visitor's start could land on an owner's `npm run demo`. After a reset there are fifteen seconds of grace for the dispatch that follows. A reset nobody asked for (`recoverMemoryStore`, the local runtime reloading) does not count, or a fresh `npm run dev:local` would say "Starting a run" for a minute.
- **A claimed start is asked again when it is about to reset the board** (`refusePublicRun`): still the latest start, switch still on, provider still scripted, nobody else having reset or begun a run since, and not more than two minutes old. A start that is told no is recorded as failed. None of its three steps is retried: none is safe to do twice.
- **`POST /api/admin/llm` refuses a model while a run is going** (409): each agent reads the choice when it starts, and a re-derive is a new start, so the rest of a visitor's run would have called the model.
- **`scripts/ab.ts` switches public runs off while it measures,** waits for a run in progress to end first, and puts the switch back, on Ctrl-C too. Between two modes the board is at rest, which is when a start is allowed.
- **`resetDemo` tidies after itself when it fails:** the half-made trunk copy is removed. That path is now reachable by anyone, up to forty times a day.
- **`src/worker/dispatch.ts` imports `workflowInstanceId` from `agent/instance`,** not `agent/workflow`, which would now be a cycle.

### An independent check before deploying

A reviewer agent, told to break nine claims about the endpoint and not to edit anything, found no blocker and said ready. What it found and what was done:

- Fixed: a failed start disabled the guard after someone else's reset until the next successful start (the failure now records when it was found out); an owner's reset was invisible until it finished (`resetBegun`); a claimed start was not checked again (`refusePublicRun`); the public status carried the raw error text of a failed start (it is a boolean now, and the text goes to the Worker's log); the Live tab said "Nothing is running" for a moment after every start, because a reset logs its numbers before any Intent exists; a stale answer from the two-second status memo could step the countdown back; a start with no answer left "Starting…" for ever (20 s timeout); a refusal reason this build does not know made the button throw.
- **Known and left.** The limits are global, so one visitor can use the day's forty starts in two hours (the owner can give them back with `clear`). Any web page can fire the POST from its visitors' browsers; the limits are the answer to that too. An Intent waiting on a person counts as at rest, so a visitor can start a new run over a board whose owner was about to answer a card. A waiting agent publishes every 30 seconds, so a run stuck behind one blocks Start until the fifteen-minute rule, not the three-minute one. An owner who switches the provider from a model back to scripted while a model run is going exposes that run to the three-minute stall rule. The advice in the README covers the last three: switch public runs off around any run you care about.

### Three runs on Cloudflare (Worker version `ba28d849`)

Started without a token: two with a bare POST, the third with the button on the deployed page.

| Run | Seed | First Intents after | Over after | Agents landed | Workload landed | Problems on trunk | Premises broken | Re-derives | Forks |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 7 | 47 s | 3:28 | 12 of 12 | 26 of 30 | 0 | 5 | 5 of 5 | 45 |
| 2 | 11 | 31 s | 3:12 | 12 of 12 | 26 of 30 | 0 | 3 | 3 of 3 | 45 |
| 3 | 23 | about 30 s | about 3:10 | 12 of 12 | 26 of 30 | 0 | 5 | 5 of 5 | 45 |

- A second POST sent at once, and three more during run 3, were refused (429, "running"). A body asking for a thousand Intents and a model was refused the same way, unread. The switch without a token: 401.
- Run 1's reset took about 40 seconds because it deleted the 113 forks the afternoon's comparison had left; later ones delete 45. A run is three to four minutes, longer than the wait between starts, so in practice the next start is allowed as soon as a run ends. The page said "about two minutes" before this and says "three to four" now.
- The four workload Intents that do not land are the same kind each time: the generator aims some edits at a function an earlier edit already touches, and the later one gives up waiting for the claim. That is the ledger working. It is not a failure of the run, though "4 scripted workload Intents did not land" does not say so.
- Checked on screen during the runs, at 1440×900 and at 375 wide: "Starting a run." while the old board is cleared; then the story's own sentences as they became true ("Three agents relied on how it used to behave. They are stopped at once."; "Agent 11's tests all still pass. Only its premise caught the problem."); then the summary and "Start a new run".

### Documents

- README: "See it in 2 minutes" is about the two tabs; a paragraph on the Start button for someone who deploys their own; a new section, **How this would scale**, written after re-reading the official rules. The rules ask for a prototype and say nothing about the size of the codebase; the competition page's headline is "hundreds of thousands of agents". The section says what is shaped for that (forks, the sharded ledger, invalidation by type), what is not (one gate; a whole-repo typecheck in the Worker; every test and every in-flight assertion run after every landing; one language), and that none of it has been built or measured.
- `docs/video/script.md` and `shot-list.md`: the comparison now comes before the larger run, because that is the order on the page; both are reached by scrolling, not by tabs. `stage-10min.md`: switch public runs off before going on, and why. `docs/UI.md`: the two tabs.
- `npm test`: 1,010 passed, 4 skipped. `scripts/check-scenario.ts`: 43 of 43.

### Later that evening: polish from the user's own pass over the page

- **A bug:** Demo, then Live, then Demo again showed no lanes, only the Compared panel. The stream starts a recording again from nothing when it is given back, and only a newly loaded recording was being put on a step. Coming back now returns to the place the reader had left (`leftAt` in `App.tsx`).
- **Lanes are coloured by how the Intent stands** (green landed; red stopped, needs a person, or did not land; yellow being redone), across the whole row, and have gaps between them. Yellow was the user's question ("should we use yellow?"); the answer taken was yes, because red, yellow, green is the order a stopped Intent goes through. That left amber meaning two things, so **waiting is no longer a colour**: its bar is hatched grey and its status word is grey. `Band` in `src/ui/lib/view.ts` is now named for meaning (`redo`, not `bluestamp`; no `amber`), and `washOf` gives a lane's colour. The washes were chosen by contrast, not by eye: the numbers are in `theme.css` and `docs/UI.md`.
- **The details panel:** a 2px ink top line and a shadow; Close moved from the far right of the header to a tab on the middle of the top edge, beside the grip; the dividers between its columns drag (`dragColumns` and `columnEdges`, pure, in `view.ts`). No dimming of the board behind it: the panel is not modal, and the row it is about has to stay readable beside it.
- **The Live tab's loading state** is the tape's shape at full width. Until the board has been read the sentence is "Opening the live board.", not "Nothing is running", which was not yet known; the small label reads "Connecting to the Worker…" and then "Live".
- `npm test`: 1,020 passed, 4 skipped.
- **The owner's tools are not shown to visitors.** "Dispatch tasks", "Run workload" and "Reset demo" are under More only with `admin` in the address (`/?live&admin`) or once the admin token has been typed in that session. The user asked whether to do this with a deploy-time variable. A flag in the address was chosen instead: the owner keeps the tools on the same deployment without a second build, and nothing is being protected by it, since every one of those actions needs the admin token.
- The deck (an Artifact, not in the repo) gained two slides: the ledger (Wait, Split, Depend) and how this would scale up.
- **A third tab, Results.** The comparison and the larger run had been put under the story so that there would be two tabs and not three; the user then wanted the Demo page clean and asked where the numbers should go. One tab named for what it is ("Results": what was measured) holds both panels. The earlier confusion was two number tabs with names that did not say that ("At scale", "Compared") beside a separate Replay/Live switch; this is one. `?results` opens it.
- **The live stream is harder to lose.** Reported by the user: the Live tab "keeps showing connecting". Not reproduced from here (the deployed socket answered), so three causes were closed: a socket from an earlier visit to the tab, or from React's development double-mount, could report "closed" after a newer one had opened and leave the label wrong; a connect that never answers is given up on after five seconds and retried; and while there is no socket the log is read over plain HTTP every two and a half seconds (`/api/events`), so the board shows on a network that does not carry WebSockets. A reset that happened while nothing was listening is noticed by the log's first event having changed (`restarted` in `src/ui/lib/stream.ts`).
- **"Open Agent N" is gone from More and the palette** (the user: "this doesn't make sense"; a row is opened by clicking it). The loading rows have no left band. The gap above the tape no longer scrolls away.
- **The typeface changed to Atkinson Hyperlegible** (Next for text and numerals, Mono for labels), chosen by the user from six pairings mocked beside Geist on one page. Two dependencies added, `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono`, and the two Geist packages removed: the faces are self-hosted so that the offline copy of the site has them. Its mono is a little wider than Geist's (7.6px a letter at the label size, not 7.4), so the estimate that decides whether a word fits on a bar went up (`wide` in `TapeView.tsx`). Its zero is slashed, in the big counters too; that is the face doing its job. The slide deck and the type-options page are Artifacts, not in the repo: the deck is still set in Geist.

### A record of live runs (asked for by the user: "an archive of past live runs")

- **What is kept.** When the board is cleared, the run that was on it is kept as one line in the EventHub (`runs` table; `src/shared/runs.ts` has the shape, `src/worker/live/runs.ts` makes the line): who started it, when, how long, agents and workload Intents landed, premises broken, re-derives, problems on trunk, whether a person stepped in, and whether it had finished. The last thirty are kept. `GET /api/runs` returns them newest first, with the run on the board now as `current`.
- **What is not.** A run under one of the comparison's other two rules is not kept (it is not a run of Premise, and its numbers are in the comparison). A board with no agents on it has no line. The events of a past run are not kept on main: only its line.
- **Who started it** is told to the hub at the reset that begins a run (`resetDemo(env, { origin })`): "visitor" from the public Workflow, "owner" otherwise.
- **`src/shared/runs.ts` is a new shared file,** not a change to `types.ts`: the Worker writes the lines and the UI reads them.
- **On the page** it is the first panel of the Results tab. Its headline is counted from the runs that finished, good or bad (`runsHeadline`), and nothing is filtered: a run that let something through, or was cleared half way, is a row like the others.

### Playing a past run again (branch `past-run-replay`; a trial, not merged when this was written)

- **What it adds.** When a run is kept as a line, its event log is kept with it (`run_events`, copied inside the hub's database at the reset; a run with more than 6,000 events is kept as a line only). `GET /api/runs/:id/events` serves it, a page at a time. `/?run=<id>` plays it in the Demo player exactly as a bundled recording is played: the story's steps are worked out from the log, so a past live run gets its own story with no hand-written text. The Results table links each run that has events ("Replay").
- **What it did not have at first.** The Changes column: what each Intent changed is read from its fork, and the forks are deleted at the reset that keeps the run. Keeping the diffs would mean reading twelve forks during every reset, while a visitor is waiting for their run to start. See the next section for how it got one.
- **Tried** on the local Worker: two runs from the Start button, then `/?run=4` played the first as an eight-step story of twelve agents, through to "Agent 11's tests all still pass. Only its premise caught the problem."
- **Cost if merged:** about 1,000 rows written to the hub's database at each reset, and up to thirty logs kept (a few megabytes in all).

### What an Intent changed, in a replay of a past run (Oct 12, night; the user: "should we use durable objects or another canonical artifacts repo?")

- **Neither. The run's own trunk is the record.** Every landing is already a commit on the trunk the run used, so nothing has to be copied anywhere. A run that is kept keeps its trunk repo in Artifacts; the EventHub (the Durable Object) keeps what it already kept, the line and the log, and now the name of that trunk (`RunSummary.trunk`). Code stays in git; the index of runs stays in the object.
- **Why not diffs in the Durable Object.** They would have to be worked out at the reset, by reading forty-two forks while a visitor waits for their run to start, and they would be a second copy of what git holds.
- **Why not a second, canonical repo.** The Artifacts binding cannot write, so an archive repo means an isomorphic-git push of every fork at every reset: slower again, and a new way for a reset to fail. The trunk is that repo already.
- **How a diff is found.** `landingOf` (pure, `src/worker/live/runs.ts`) reads the kept log: the gate's result for the Intent names the commit it landed at, and the commit trunk was announced at before that one is its parent (for the first landing, the commit the first Intents were forked from). `GET /api/runs/:id/intents/:intentId/diff` compares the two on the kept trunk with the same code the live diff uses (`landedDiff` in `routes/diff.ts`). The answer never changes, so it is cached for an hour.
- **The reset.** `resetDemo` used to delete the trunk it was replacing. It now tells the hub which trunk the leaving run was on, and afterwards removes every `trunk-*` copy that is neither in use nor the trunk of a kept run (`staleTrunks`, pure). That also clears copies left by a reset that stopped half way, which nothing removed before. At most thirty small repos stay in the namespace, and each goes when its run drops off the list.
- **What it cannot show, and says so.**
  - An Intent that did not land has no changes to show: its fork is gone and it has no commit on trunk. The panel says nothing of it landed on trunk in this run.
  - Scripted workload Intents land several to a commit, and the commit is all there is to compare. The diff carries `together` and the panel says "in one commit with N other workload Intents: these are the changes of all of them."
  - What is shown is the work as it landed (after a rebase or a re-derive), not the attempt that was stopped.
  - A run kept before this change has no trunk named, and a trunk that has been removed cannot be read. Both say "The trunk of this run can no longer be read". On the local Worker (memory repos) that happens to every kept run when the Worker's code is loaded again.
- **Types.** `IntentDiff` gained an optional `together`, and `RunSummary` an optional `trunk`. Neither is in `src/shared/types.ts`.
- **Tried** on the local Worker: two runs from the Start button, then `/?run=6`. All twelve agents' panels show their own diff ("2 files changed, +19 −1. As it landed on trunk."); twenty-six workload Intents show their commit's; the four that did not land say so. The same is asserted in `live.workers.test.ts` against a full run.

### Three reviews, and what was changed because of them (Oct 12, night)

Three independent reviewers read the code: the UI and the Worker at `ef764e5`, and the replay line before it was merged. None found a blocker.

- **Replay line.**
  - The commit before a landing is now read from the repo (`RepoStore.parentOf`, a new port method over the binding's `readCommit().parents`), not worked out from the log. An announcement of trunk moving can be lost, and the log's "before" would then have shown one Intent another's changes as its own.
  - A reset deletes only trunks this hub can vouch for: the one it just replaced, if its run was not kept, and the trunk of a run that has just dropped off the list. The first version swept up every `trunk-xxxxxxxx` it did not know, which would have deleted another Worker's trunk on a shared namespace. A copy left by a reset that stopped half way is, as before, removed by that reset itself.
  - Where an Intent landed is asked of the hub once per run and Intent and remembered in the isolate; `together` counts only the Intents a commit carried; landings have a memo of their own.
- **Worker.**
  - An agent's status changes are Workflow steps (`status-<n>-<action>`). Made outside a step they were made again on every replay of the Workflow, and stopped the run.
  - A push to trunk whose reply was lost is a landing, not a failure. Before, the retry found nothing to commit and landed the work without announcing that trunk had moved.
  - `premise/assert.ts` can be read by an agent and not written.
  - A public start checks the provider again when it dispatches; a model that cannot be set up fails the Intent with the reason; one failed read of the task list is not remembered for the run; `scripts/ab.ts` puts public runs back on if its wait fails; an observed premise is marked recorded only after the write.
  - Events of the run before that name their Intent in `report.intentId`, `byIntent` or `detail.intent` are dropped like the others.
- **UI.** A reconnect that finds the board was reset keeps the whole log; the details panel no longer plays its entrance again after a drag; the "Live" label goes off when polling fails; and eleven smaller ones (focus on Next, Space on a focused control, phone loading state, lane outline contrast, the countdown not stepping back, a live-model run saying so in the runs table).
- **Left for later, on purpose** (none is reached by the scripted public run):
  - A claim across ledger shards that a later shard refuses loses the requester's readers and earlier claims there (the reviewer's finding 4). The fix is a new `unclaim` and a change to Split; too large to make safely two days before the deadline.
  - A run's line takes `scripted` from the provider at the reset, not the one the run used; `endedAt` follows any late event; a re-derive whose start is retried counts twice; a quarantined Intent's wake-up is not retried; a public start does not check that the board is still the one it reset; dead CSS.
- **A mistake of mine while doing this:** a link named `node_modules`, made for a second checkout, was committed there (`node_modules/` in `.gitignore` does not match a link), and merging it replaced the real directory. It was taken out of the merge and the packages reinstalled from the lockfile. Nothing else was touched.
- `npm test`: 1,059 passed, 4 skipped. `scripts/check-scenario.ts`: 43 of 43.

### A staging Worker, and the replay line tried on it (Oct 12, late night)

- **`npm run deploy:staging`** builds `wrangler.staging.jsonc` (`vite build --mode staging`) and deploys a second Worker, `premise-staging`, with its own Artifacts namespace (`premise-staging`) and its own Workflow (`premise-agent-staging`). It has no queue consumer (a queue has one, and it is production's) and no admin token unless one is set, so its admin routes refuse everything. A reset deletes every Intent fork in its namespace, which is why it does not share production's.
- **Tried there on real Artifacts,** three runs from the Start endpoint, each 12 of 12 agents and 26 of 30 workload Intents landed with nothing broken on trunk. After the third reset: both kept runs replay; every agent's diff is its own (twelve different test files for twelve agents, the three re-derived ones included); 26 workload Intents show their commit's changes with the count it carried; the four that did not land answer 404; the two kept trunks and the one in use are the only trunks in the namespace, and the only forks are the current run's 45.
- A script asking with Python's default user agent is refused by Cloudflare (error 1010); the probe sends another.

### After staging: production, three more live runs, and what is left on Cloudflare (Oct 12, late night)

- **Production has the replay.** The tested line was merged to `main` and deployed (`746fff1b`). Three live runs were then started there from the public Start endpoint, each 12 of 12 agents and 26 of 30 workload Intents with nothing broken on trunk. The first reset after the deploy kept the run that was already on the board, with its trunk, so that run can be replayed too. All three kept runs were read back: every agent's diff is its own, and the workload Intents show their commit's changes.
- **`scripts/staging-teardown.sh`** removes the staging Worker, its Workflow and the repos in its namespace. It lists them and asks first. It is run by a person: deleting cloud resources is not something a coding session does on its own. Wrangler has no command to remove a namespace, so the empty `premise-staging` namespace stays listed, as `premise-spike` does.
- **What production's namespace holds** after those runs: `trunk` (the original), the trunk in use, one trunk for each kept run, and the forks of the run on the board. Nothing there is stale: a reset removes a trunk when its run drops off the list of thirty.
- **Not ours to remove:** the `forkcast-demo` and `keepers-demo` namespaces belong to other projects on the same account.
- **A checker and a preview for the slide deck** were written outside the repo (the deck is an Artifact, not a file here): a linter for the Slides format's closed subset and a page that renders slide files locally, so that a slide can be looked at before it is published.

### The video deck, redrawn, and a script to read over it (Oct 12 night to Oct 13)

Asked for by the user: slides that match what is built, approachable, organised around the parts of the system, with icons, pictures and simple animation; the same typeface as the site; and a script to read from while recording, with what to do in brackets.

- **Twenty slides, in `docs/video/deck/`** (the published deck is a claude.ai Artifact made from these files). The middle of the deck is the six parts, one slide each (agents, forks, the ledger, premises, re-derive, the gate), after an overview that numbers them. The ledger has two slides: what it is ("a sign-up sheet for the code") and its three answers. New since the last deck: the overview, forks, the three answers, and a slide on live runs (start one, every run kept, replay). The old `intent` slide became `agents` and `forks`.
- **Every content slide is a picture built from pinned pieces,** not cards of text, and builds in steps: a piece with `data-build-in` appears on a press of the right arrow. The first piece has no build, so a slide opens with something to talk over, and the script's presses count from there.
- **Looping motion is in live embeds, not in drawings.** The Slides format's own pages disagree: one says animation inside an inline `<svg>` is fine, another says the viewer shows an inline svg as a still image and its build rejects SMIL. The stricter one was followed. A travelling dot or a pulse is a small `<x-embed>` over a picture that is complete without it.
- **Set in Atkinson Hyperlegible Next and Mono,** the site's faces, in the site's palette, with the site's lane colours (green landed, red stopped, yellow re-deriving).
- **How it was made.** One agent per slide drew it, each rendering its own slide and looking at it; the six parts and three other slides were drawn twice, in two visual directions, and the better one chosen from the renders. An independent critic and a fixer followed each, then a second independent check for facts, then three reviewers read the whole deck in order. Every number on the deck was first checked against the repo and the live site, and wordings the checks called loose were tightened (what Depend does as built; what the ledger does and does not find; "a fresh isolate every time", not one for each test; that no model works in a live run).
- **Order changed at the end** on two reviewers' advice: the measurements together (compared, at scale), then live runs, then how it is built and scaling, and the honest slide last before the closing one, where "One more thing" belongs.
- **`docs/video/screen-recording-script.md`** is the read-aloud script: about 1,230 spoken words, about nine minutes with the presses and two short visits to the site. Each slide's speaker notes are copied from it (`tools/sync_notes.py`), and `tools/check_script.py` checks that the script's presses equal each slide's build steps. `script.md`, the older site-only cut, stays, and its rules for the read apply to both.
- **Tools kept with the deck** (`docs/video/deck/tools/`): a linter for the format's closed subset and this deck's own rules, a local preview page, and a one-command render with headless Chrome. The preview is an approximation: stand-in icons, all build steps shown at once.
- **Not seen in the real viewer.** The published deck needs the owner's sign-in, so the build steps and the embeds' motion have been checked against the format's documentation and in the local preview only. If an embed does not run, the slide loses nothing but the motion.
- **Still a placeholder in spirit:** the closing slide says "The repository link is in the submission." until the repo is public and has an address.


### A closer view of a long run (Oct 13)

- **Asked by the user:** a session that runs for hours should stay readable, with the agent column fixed and the lanes scrollable. Today the axis stretches to hold the whole run, so after two hours a one-second rebase is thinner than a pixel.
- **Built instead of scrolling: three choices where the word "Time" stands, All / 10 min / 2 min,** offered once a run passes ten minutes. A closer view shows only the last stretch, with its left edge moving in steps so nothing slides (`zoomTape`, pure, in `src/ui/lib/tape.ts`). There is no scroll position to keep in step with the live stream, and the tape's one animation is untouched. The cost: on the closer views you cannot look back past the window; "All" is still there for that.
- The clock says hours from an hour on ("2:05:00", not "125:00").
- **Tried** on a copy of the front-page recording with its times stretched a hundredfold (1 h 49 min): the control appears, "10 min" shows 22:30 to 32:30 with the bars at a readable size, and seeking still lands where it is clicked. No real multi-hour run has been made.
- **Agents that start late already work:** a row appears when its Intent is created, and its bar starts at that moment. Two rough edges are left: rows and "Agent N" numbers follow task order, so a late agent with an earlier task is inserted above others and renumbers them.

### Dynamic Workers are billed by the number created, so the public cap came down (Oct 13)

- **Reported by the user:** a charge for Dynamic Workers. The runner makes one with `env.LOADER.load(...)` for every batch of tests and premise checks, and Cloudflare bills each unique Dynamic Worker created in a day ($0.002 beyond 1,000 a month; `load()` with no ID counts as a new one every call).
- **Done now:** the public Start button allows ten runs in any 24 hours, not forty (`PUBLIC_RUN.dailyCap`). That is the bound on this part of the bill.
- **Not done yet:** giving identical runs a stable ID (`LOADER.get` with a hash of the code), and running fewer isolates. See the next note once measured.

### Isolates are named for their code (Oct 13; the user chose this over a fresh isolate every run)

- **Measured first,** with a temporary counter on the local Worker: a live run starts 95 isolates. About a third repeat within the run (one premise check runs fifteen times; most gate runs happen twice with identical code), and a second run repeats all but about six of the first.
- **The change:** `runInIsolate` asks for its isolate with `env.LOADER.get(id, …)`, where the id is a SHA-256 of the compatibility date, the CPU limit and every module (`isolateId`), instead of `env.LOADER.load(…)`. Billed creations for ten runs in a day should fall from about 950 to about 120. Not yet read off the dashboard.
- **What was given up:** "a fresh isolate every run". The user asked whether memory could be cleared first; it cannot (a Worker cannot re-evaluate its modules, and there is no way to ask for a fresh isolate under the same name). Instead the runner counts its own runs and the result says `reused` when the isolate had run before.
- **Tests:** the old test that required a fresh isolate was rewritten to the new promise (reuse is reported; different code never shares). New ones run the trunk suite and every task's reference solution three to five times and require the same answers, and a deliberately leaky test shows the flag is set exactly when state was seen again. On the local runtime an isolate was handed back every time, so these do exercise reuse.
- **Found on the way:** files are compiled before they are hashed, so a change that is only a comment or a blank line is the same code.
- `reused` is on `RunResult` only; it is not in the gate's report or the event log.


### An agent left at "claiming" on staging, and why (Oct 13)

- **Seen** in the first staging run after the isolate change: 11 of 12 agents landed; the twelfth stayed "claiming" with no answer from the ledger, and its Workflow had completed. Not caused by the isolate change.
- **Cause:** last night's review fix made each status change a Workflow step. A step is run again when its reply is lost; the Intent had already moved, refused the same change, and the driver read that refusal as "stopped". (The risk was noted when the fix was made and not handled.)
- **Fix:** a refusal is not a stop when the Intent is already where the change would have put it (`alreadyApplied`, pure, in `intent/machine.ts`). A test runs every status step twice and the agent still submits; without the fix that test fails.
- This was on production from the evening of Oct 12; nine runs there and on staging had not hit it.

### A past run opens beside the list (Oct 13; the user picked option A of three mocked on a design canvas)

- **Why:** opening a past run meant going to the Demo player and pressing Next or Play through it. The user wanted to see it at once, without leaving Results.
- **What:** "Open" on a row of the Live runs table opens `PastRunPanel`, a side panel three quarters of the window wide. It shows the run at its end, with the same `TapeView` as the board; the time axis seeks; a row opens the same `Drawer` (drag its height, drag its columns) at the foot of the panel, with the Intent's changes as they landed. Esc closes the details panel, then the side panel. "Play it as a story" keeps the old route, and the link still opens `/?run=<id>` in a new tab.
- **Reused, not rebuilt:** `TapeView`, `Drawer`, `useIntentDiff`, `storyFor` (for the agents' names and the closing sentence), `reduceAll`, `buildTape`. `fetchPastRun` moved from `App.tsx` to `src/ui/lib/pastRun.ts`. The only new styles are the panel's own, and one rule that keeps the details panel inside it at every width.
- **Tried** on the local Worker at 1440 wide: opened a kept run, opened Agent 2 ("2 files changed, +50 −11. As it landed on trunk."), dragged the details panel from 300 to 450 pixels, sought to an early moment and back. Not tried at tablet or phone width.


- **Oct 13, afternoon:** the public cap is twenty a day for now (the user's call, for the day of the screen recording). At about 95 Dynamic Workers a first run and far fewer for repeats, that is a small bill. Put it back to ten afterwards.

### The deck on the site, at /slides/ (Oct 13; the user asked for a "How does it work" link and a first-visit card)

- **What:** `docs/video/deck/tools/build_player.py` turns the deck's slide files into one static page, `public/slides/index.html`, which the Worker's assets serve at `/slides/`. It is our own renderer of the slide format (the same one `preview.py` uses, plus stepping through the builds), not the Slides page on claude.ai, so the icons are stand-ins. Under each step it shows what the read-aloud script says there, cut from the slide's `<aside>` at each `[→]`; what is said while the browser is on screen is left out.
- **The generated page is committed.** `npm run build` does not run Python. After any slide changes: `npm run slides`, then commit.
- **On the site:** "How does it work?" in the top bar opens the deck over the page in a frame (`SlidesOverlay`); a modified click follows the link to `/slides/`. A card offers the slides once: on the first visit to the plain Demo page, never on a link with a query (`?run=`, `?live`, …), and it is recorded as shown the moment it appears (`src/ui/lib/firstVisit.ts`, tested). Where the browser refuses storage, the card is not shown at all.
- **Fonts** on the slides page come from Google Fonts (the deck's own `faces`), not the site's bundled files.
- **Tried** locally at 1280 wide and at phone width: all builds of the ledger slide, its moving dots, Back across a slide boundary, the overlay's Close, the card on a first visit and its absence on the second.

### The owner can remove a kept run; runs with fewer agents (Oct 13, evening; the user asked for both)

- **Delete.** `POST /api/admin/runs/:id/delete` (admin token) removes one kept run: its line, its events, and its copy of trunk when nothing else needs that copy (not the trunk in use, not the original, not another kept run's; `staleTrunks` decides, as for a reset). The run on the board is not a kept run and cannot be removed this way. On the Results tab a past run's whole row is the thing to click (there is no "Open" link any more; the time in the row is a button, for a keyboard) and it opens the side panel. There the owner (`?admin`, or the token typed this session) has a "Delete" button, which asks in a pop-up before it acts ("Keep it" has the focus). A visitor sees no button. The owner can open a run whose events were not kept, to remove it. After a delete the list is asked for again at once, so the headline, the rows and "Show all N" are from the record as it is.
- **The page's claim changed with it.** It used to say "None is left out". It now says the page leaves none out and that the owner can remove a run. Deleting a run that went wrong would make the headline look better than the truth, so do not do that; it is for clearing test runs.
- **Fewer agents.** `npm run demo -- --agents 5` dispatches five of the twelve tasks (the four the premise break is about first, then the rest in order); `--tasks a,b,c` names them. Nothing in the Worker changed: `/api/dispatch` always took a list. Such runs are the owner's, so they do not count against the public cap. A public run is still all twelve.
- **A run about something else:** `--tasks t05-tax-rounding,t06-discount-stacking,t09-currency-format`. `t05` and `t06` both want `computeTotal`, so this one shows the ledger (a card that settles by itself when the other lands), not the `verifySession` premise break.
- **Tried locally:** 5 of 5, 7 of 7 and 3 of 3 landed, nothing broken on trunk; the 5-agent run opened in the side panel ("All five agents' work landed"). Delete: refused without the token, removed a run with no trunk on record and one with its own copy (the copy went), 404 the second time.

### A slide on where Premise would sit (Oct 13, night; the user asked for it, towards the end)

- `fits` is slide 19, after "Scaling up": tasks, any agents, Premise (ledger, premises, gate), trunk, then CI and deploy, with the stop-and-re-derive loop back to the agents. It says "would": connecting an existing Git host is not built, and the notes say trunk lives on Artifacts today.
- "The honest part" is now slide 20 and "Try it" 21. The script grew by about 80 words, to about 1,310: about 9:35 at 150 words a minute, which is close to the ten-minute limit. The script says which slides to press through if the take runs long.
- The first-visit card no longer names a number of slides.

- **Oct 13, late:** the read-aloud script was trimmed to the main points at the user's request, from about 1,305 spoken words to about 1,010 (about 7:40 at 150 words a minute with the presses and site visits). Every press and every bracketed action is kept; the disclosures (scripted agents, the planted break, Premise being slowest, the live-model result) are kept. The slide notes and the captions on `/slides/` follow it.

- **Oct 14:** the repo is public at https://github.com/akshat12/premise (the name the checklist suggested), `main` only. A scan of the tracked files and the whole history before the push found no secrets: only the placeholder admin tokens. The address is in the README's clone line, the shot list and the closing slide.

- **Oct 14:** a visitor with an ad or privacy blocker saw the Live tab stuck on "Connecting to the Worker" (`ERR_BLOCKED_BY_CLIENT` on `/api/events` and `/api/events/ws`: blocker lists take `/api/events` for analytics). The page now reads the log at `/api/board/history` and `/api/board/history/ws`, and a kept run at `/api/runs/:id/history`; the old paths still answer, for the scripts. The Premise name in the top bar is a link to `/`.

### The workload list (Oct 14; the user asked to see the workload Intents one by one)

- Clicking the Workload row on the board (Live tab, Demo tab, and a past run's side panel) opens the bottom details panel with one line per workload Intent: its tag (`w7_11`), what the edit does, where it got to, and, when it did not land, why ("Gave up waiting: w7_11 was changing planPrice."). A line opens that Intent's usual details, with "Back to the workload list". Pure logic in `src/ui/lib/workload.ts`, tested; the selection uses a sentinel, `WORKLOAD_LIST`, not an Intent id.
- Workload Intents are now named by their tag everywhere (`callsign`), not by their id.

### A redo whose work never reached the gate (Oct 13, night)

- **Seen once on production:** Agent 11 (t11) was stopped, its rebase failed, and its redo ran, pushed and was checked; its Workflow completed. But the redo never reached the gate's queue, and the gate went on waiting for it until its 20-minute timeout. Agents 2 and 3 took the same path seconds earlier and landed. The cause is not found: nothing in the event log says where the hand-off was lost, and the Worker's error log was not readable from here.
- **Safety net (`gate/lost.ts`, pure, tested):** while redos are running, the gate wakes every 30 seconds. A redo that has run at least a minute, whose Intent is still on that attempt with a push from that attempt's fork, whose agent Workflow has completed, and which is not queued, is put in the queue as a redo. The timeout skips a redo whose work is queued. `GATE_VERSION` is 9.

- **Oct 14:** the "honest part" slide (live-model result) is out of the deck and the script at the user's request; the deck is 20 slides and the script about 920 spoken words. The README still says what the live-model runs showed. The site's slide player has a typeable slide number: Enter goes there, Escape or a number out of range puts the current one back.

- **Oct 14: the live board's "now" glides.** On the Live tab "now" was the newest event's time, so the line and every open bar jumped forward whenever events arrived (in bursts) and stood still between them. It now follows the Worker's clock every animation frame (`followClock` in `ui/lib/tape.ts`, tested), the way a replay already glided. The clock's lead over this machine is the largest seen from the live status and from arriving events, so it never steps back; the axis is always the one "now" itself needs, so a new event never narrows it. Gliding stops once every Intent is at rest. Measured locally over a 12-agent run: 17.7 px a second throughout, at most a third of a pixel a frame, no jumps.
- **Then (Oct 14):** when "now" needs a wider axis, the axis widens over 0.6 s with an ease-in-out (`easeSpan`), and an event arriving mid-way does not cut it short. Measured on production in headless Chrome over a 12-agent run: 0.2 to 0.4 px a frame throughout, never still while the run moves, no forward jumps; the two widenings took 34 frames, the largest step 15 px (it was one 250 to 340 px jump). A run that has just started still shifts once as its first rows appear: the board's columns change width, not the clock.

- **Oct 14: one press, one slide.** At the user's request every build step (`data-build-in`) is gone from the slides, so each appears complete; the looping moving parts (`x-embed`) stay. The deck was drawn so the finished picture reads on its own, and the busiest slides were rendered to check. The read-aloud script is now one plain paragraph per slide, in full sentences, with every action kept: about 1,030 spoken words, about 8 to 8:30 with the two site visits.

- **Oct 14: the panels slide.** The details panel slides up from the bottom edge and the past-run side panel in from the right (with its backdrop fading), and both slide back out when closed: about 0.26 to 0.28 s in and 0.17 to 0.19 s out. They are CSS transitions, not keyframe animations, so reopening while one is still sliding out carries on from where it is. `usePresence` keeps a closed panel on screen for its exit; `useEntered` gives it an off-screen first frame. With reduced motion there is no slide. Measured in headless Chrome at 1440 and 1100 wide: every slide moves one way only, the largest frame is 40 px for the bottom panel and 127 px for the side panel, and rows can be clicked again as soon as a panel starts to leave.
- **Then:** a past run's timeline is drawn once its side panel has slid in (`PANEL_IN_MS`): drawing a whole run mid-slide dropped frames on production. The title slide now has the project name large at the top, the author's name, and links to the site and the GitHub repo; on the site's slides a link opens in a new tab and does not advance the slide.

- **Oct 14:** the public cap is back to ten runs in any 24 hours (`PUBLIC_RUN.dailyCap`), as planned after the screen recording. It is the bound on the Dynamic Worker bill from visitors' runs; the owner's runs (admin token) are not counted.

### Phones (Oct 14, on the branch phone-fixes)

- **Audit at 375 x 812, 320 x 640 and 740 x 360 (sideways), and desktop at 1440 x 900, in headless Chrome as a phone (touch, mobile).** Already fine on a phone: no page scrolls sideways at 375, the details panel is a bottom sheet that scrolls, the workload list, the comparison and scale sections, the More menu, the first-visit card and the slides overlay.
- **Fixed:** (1) on a phone the "now" line is drawn under the rows and the row words sit above it with a soft edge, so no line runs through a name; (2) an axis mark the playhead's readout covers is not drawn (every width); (3) the workload's counts wrap instead of being cut; (4) the runs table on a phone keeps three columns (when, agents landed, problems on trunk) instead of hiding the numbers off to the right; (5) a past run's panel head goes on two lines; (6) the slides page says to turn the phone sideways when held upright; (7) at 360 wide and under, the top bar tightens so its four parts fit, and the measurements table scrolls inside its own box.
- **Checked after:** desktop screens look as before; on a phone, a row opens the sheet and Close slides it away, a past run opens full width with its own sheet and changes, the on-the-board row goes to the Live tab, the slides overlay steps and closes. Tests pass.

- **Oct 14:** the title slide uses the website's mark (the tab icon: dark rounded square, white corner brackets, orange dot) and its wordmark style; the scaling slide adds "A UI for long runs: agents that work for hours or days" to what would change next, with a matching sentence in the script.

- **Oct 14: the deck is 17 slides.** At the user's request: dropped "six parts", "the ledger's three answers", "at scale", "live" and "try it"; added "Demo" (both visits to the site now happen there) and "Thank you" (name and links). The script is one conversational paragraph per slide, about 980 spoken words, about 8 minutes with the demo.

- **Oct 14: security audit of both public repos** (a subagent, from fresh clones, every file and every blob in history). No secrets: no API keys or tokens of any kind, no private keys, no committed env files; only placeholder admin tokens. Fixed what it flagged: the Cloudflare account id is no longer committed (`CLOUDFLARE_ACCOUNT_ID` is empty in all four wrangler configs; it is only used for `LLM=workers-ai`, which now says to set your own); the icon script no longer has a home path. The old spikes Worker is gone; the staging Worker still exists until `scripts/staging-teardown.sh` is run. A stranger deploying uses their own account, admin token and model key. The commit email stays in history (normal for git).

- **Oct 14: Node 24, and only 24, in both repos** (the user's call, for one simple instruction). `engines` is `>=24.0.0`, `.npmrc` sets `engine-strict=true` so `npm install` refuses an older Node before installing anything, and `.nvmrc` says 24 for nvm and fnm. Premise also has a preinstall check with a plain message (`scripts/check-node.mjs`) for anyone who turns engine-strict off. Tried from clean copies: Node 20 and 22 are refused with nothing installed; Node 24 installs, tests and typechecks in both repos. (Node 22 also passed every Premise test before the rule went in.)

- **Oct 14:** the deck ends on "Demo" (16 slides; "Thank you" removed). The take ends in the browser with the closing lines, so there is no switch back to the slides; the Demo slide carries the name and the GitHub link.

- **Oct 14:** a slide after "Agents", "Two kinds of Intent", says plainly what agent Intents and workload Intents are (the deck is 17 slides again, ending on Demo), with a matching paragraph in the script. The top bar has a "GitHub repo" link to the public repo (under More on a phone, where the bar has no room).
- **Then:** on a phone only, a slim note under the top bar says "Best viewed on a computer: the timeline is made for a wide screen", with Dismiss; once dismissed it stays away (remembered in the browser). Desktop never shows it.
- **Oct 14:** at the user's request the video notes (`docs/video/script.md`, `screen-recording-script.md`, `shot-list.md`, `dry-run.md`, `stage-10min.md`, `end-frame.html`) and `docs/SUBMISSION.md` are no longer in the repo. They are kept on the owner's machine in `private/`, which git ignores; the deck tools take the script's path as an argument, so `sync_notes.py` and `check_script.py` work from there. The slide deck source stays, since `/slides/` is built from it. Older notes above still name the old paths.
