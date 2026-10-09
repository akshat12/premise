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
