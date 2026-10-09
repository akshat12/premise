# T00: Spikes (prove the three risky assumptions before building)

## Goal
Prove three things with real calls. Record the results in `docs/DECISIONS.md`:
1. A Worker can **create, fork, read and push** to Artifacts repos. Pushing uses isomorphic-git against a **fork**, starting from a shallow clone.
2. The **TypeScript compiler API runs inside a Worker** and emits `.d.ts` from in-memory files, including the standard lib.
3. A **Dynamic Worker** (`env.LOADER`) can run transpiled TS modules that import each other and return test results.

This is throwaway code. Put it in `spikes/` (a separate mini Worker). It is not the app.

## Read first
- `CLAUDE.md` (all of it)
- `docs/vendor/cloudflare/artifacts/api/workers-binding.mdx`
- `docs/vendor/cloudflare/artifacts/examples/isomorphic-git.mdx`, which has the full MemoryFS helper. Copy it.
- `docs/vendor/cloudflare/artifacts/api/git-protocol.mdx`
- `docs/vendor/cloudflare/sandbox/get-started/dynamic-workers.mdx`

## Steps
1. `mkdir spikes && cd spikes && npm init -y`
2. Install `wrangler@latest typescript@5 isomorphic-git` as dependencies. Install `@cloudflare/workers-types` as a dev dependency.
3. Create `spikes/wrangler.jsonc` with:
   - `name: "premise-spikes"`
   - `compatibility_date: "2026-10-01"`
   - `compatibility_flags: ["nodejs_compat"]`
   - `artifacts: [{ binding: "ARTIFACTS", namespace: "premise-spike" }]`
   - `worker_loaders: [{ binding: "LOADER" }]`
   - `define: { "__filename": "\"/typescript.js\"", "__dirname": "\"/\"" }`
4. Create `spikes/src/memory-fs.ts`. Copy the MemoryFS helper from the isomorphic-git example verbatim.
5. Create `spikes/src/index.ts` with three routes, each returning JSON with timings in ms:
   - **`GET /artifacts`:**
     1. `create("spike-base-<rand>")`.
     2. Use isomorphic-git: `init`, write `README.md` and `src/a.ts`, commit, push `main`.
     3. `get()` then `fork("spike-fork-<rand>")`.
     4. `readFile({ ref: "main", path: "src/a.ts" })` on the fork.
     5. Shallow-clone the **fork** (`singleBranch: true, depth: 1`), edit `src/a.ts`, commit, push.
     6. `log({ limit: 5 })` on the fork.
     7. Return:
        - `forkMs`
        - `pushMs`
        - `cloneMs`
        - `commits`
        - `fileText`
   - **`GET /ts`:**
     1. Build an in-memory `ts.CompilerHost` with two files: `/src/session.ts` and `/src/use.ts`, where `use.ts` imports `session.ts`.
     2. Use `lib: ["es2022"]`. To serve the lib files, load the text of every file in `node_modules/typescript/lib/lib.es5.d.ts` through `lib.es2022.*.d.ts` and `lib.decorators*.d.ts`.
        - Import them as text with Wrangler `rules`: add `{ "type": "Text", "globs": ["**/*.d.ts"], "fallthrough": true }` to `wrangler.jsonc`.
        - Alternatively, generate a TS file that exports them as strings, using a tiny node script.
     3. Emit with `declaration: true, emitDeclarationOnly: true`.
     4. Return:
        - The emitted `.d.ts` text.
        - The diagnostics. They must be empty.
        - `ms`.
   - **`GET /loader`:**
     1. Transpile two TS modules with `ts.transpileModule`, with `module: ESNext`:
        - `src/math.ts`, which exports `add`.
        - `tests/math.test.ts`, which imports `../src/math.js` and exports `tests = { adds: () => { if (add(2,2)!==4) throw new Error("bad") } }`.
     2. Add an entry module `runner.js`. It imports the test module, runs every test, and returns `{ name, ok, error }[]`. It must be a `WorkerEntrypoint` class `Runner` with a method `run()`.
     3. Call `env.LOADER.load({ compatibilityDate: "2026-10-01", mainModule: "runner.js", modules: {...}, globalOutbound: null, limits: { cpuMs: 2000 } }).getEntrypoint("Runner").run()`.
     4. Return the results.
6. Run `npx wrangler dev` (needs `wrangler login`). Curl all three routes.
7. Run `npx wrangler deploy` and curl the deployed `/artifacts` route again. Production timings matter.
8. Delete the spike repos afterwards with `env.ARTIFACTS.delete`, or with `npx wrangler artifacts repos delete <name>`.

## Acceptance
- `curl -s localhost:8787/artifacts` returns JSON with `fileText` that matches the pushed content, and a fork log that shows 2 commits.
- `curl -s localhost:8787/ts` returns non-empty `.d.ts` text for both files, with `diagnostics: []`.
- `curl -s localhost:8787/loader` returns `[{"name":"adds","ok":true}]`.
- `docs/DECISIONS.md` gets a "T00 results" section containing:
  - The timings: fork, clone, push, ts emit, loader run.
  - Whether a shallow-clone push to a fork worked.
  - The bundle size printed by `wrangler deploy`.
  - Any workaround needed: `__filename`, lib loading, import rewriting.

## If something fails
- **Shallow push fails:** try a full clone (`depth` omitted). Record which one works.
- **TypeScript fails at runtime:** record the exact error and try `typescript@5.9`. If it still fails, STOP and report. The fallback plan (Sandbox containers) needs a human decision.
- **Loader can't resolve relative imports:** use flat module names (`src_math.js`) and rewrite imports. Record the scheme you used, because T14 will reuse it.

## Out of scope
- Do not build app code.
- Do not touch the root `package.json`.
