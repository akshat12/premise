# T01: Scaffold the app

## Goal
Set up a single npm package that builds:
- A Worker: `src/worker/index.ts`.
- A React single-page app, served as static assets: `src/ui/`.

The build uses Vite and `@cloudflare/vite-plugin`. Set up Kumo with Tailwind v4, vitest, and all bindings from `docs/PLAN.md`, with stub classes. Everything must typecheck, test, run locally and deploy.

## Read first
- `CLAUDE.md`
- `docs/PLAN.md`: the "Bindings" and "Approved dependencies" sections
- `docs/DECISIONS.md`: the T00 results, especially the TypeScript `define` workaround
- After installing, the READMEs of `@cloudflare/vite-plugin`, `@cloudflare/vitest-pool-workers` and `@cloudflare/kumo` in `node_modules`. Follow their current setup, not your memory.

## Deliverables
```
package.json            scripts: dev, build, deploy, test, typecheck, smoke, types
vite.config.ts          react(), tailwindcss(), cloudflare() plugins; define __filename/__dirname (see below)
wrangler.jsonc          all bindings from PLAN.md (artifacts, worker_loaders, 4 DOs, workflow, queue consumer, vars), assets SPA
wrangler.test.jsonc     same minus "artifacts" (remote-only binding breaks offline tests)
tsconfig.json           references: tsconfig.worker.json, tsconfig.ui.json
tsconfig.worker.json    strict, types from worker-configuration.d.ts, lib es2022, no DOM
tsconfig.ui.json        strict, DOM, jsx react-jsx
vitest.config.ts        two projects: "unit" (node env, src/**/*.test.ts excluding *.workers.test.ts) and "workers" (vitest-pool-workers, *.workers.test.ts, wrangler.test.jsonc)
index.html
src/ui/main.tsx         renders <App/> inside <div className="isolate">
src/ui/App.tsx          Kumo Button + a Kumo Flow with 3 nodes (smoke test that Kumo renders)
src/ui/index.css        the 3 Kumo/Tailwind lines from CLAUDE.md, in that order
src/worker/index.ts     fetch: GET /api/health -> {ok:true, store: env.REPO_STORE, llm: env.LLM}; everything else -> assets
                        queue(): log and ack (stub)
                        export class EventHub, IntentDO, LedgerShard, Landing extends DurableObject (stubs)
                        export class AgentWorkflow extends WorkflowEntrypoint (stub run() returning "ok")
src/worker/env.ts       re-export generated Env type if needed
src/worker/health.test.ts           unit test of a tiny pure function (proves "unit" project runs)
src/worker/health.workers.test.ts   calls SELF.fetch("/api/health") (proves "workers" project runs)
.gitignore              node_modules, dist, .wrangler, .dev.vars, .env, docs/vendor/, spikes/node_modules
.dev.vars.example       REPO_STORE=memory, LLM=scripted, ADMIN_TOKEN=change-me, ANTHROPIC_API_KEY=
LICENSE                 MIT, "Copyright (c) 2026 Premise contributors"
docs/DECISIONS.md       create if missing; add T01 notes
```

## Specifics
- **`wrangler.jsonc`:**
  - `name: "premise"`
  - `main: "src/worker/index.ts"`
  - `compatibility_date: "2026-10-01"`
  - `compatibility_flags: ["nodejs_compat"]`
  - `assets: { not_found_handling: "single-page-application" }`
  - Durable Object `migrations`: tag `"v1"`, `new_sqlite_classes` for all 4 DO classes.
  - `workflows: [{ name: "premise-agent", binding: "AGENT_WORKFLOW", class_name: "AgentWorkflow" }]`
  - `queues: { consumers: [{ queue: "premise-events", max_batch_size: 50, max_batch_timeout: 1 }] }`
  - `limits: { cpu_ms: 300000 }`, because the gate runs `tsc`.
- **TypeScript-in-Worker workaround.** Put `define: { __filename: JSON.stringify("/typescript.js"), __dirname: JSON.stringify("/") }` in `vite.config.ts`. Use whatever T00 found actually works. With the Vite plugin, Wrangler's own `define` may be ignored.
- **`package.json` scripts:**
  - `"dev": "vite"`
  - `"build": "vite build"`
  - `"deploy": "npm run build && wrangler deploy"`
  - `"test": "vitest run"`
  - `"typecheck": "tsc -b"`
  - `"types": "wrangler types"`
  - `"smoke": "tsx scripts/smoke.ts"`. Create `scripts/smoke.ts` that only calls `/api/health` on `process.env.PREMISE_URL`.
- **Queue.** HUMAN: the queue must exist before deploy. Ask the user to run `npx wrangler queues create premise-events`, unless you are already authenticated, in which case run it yourself.
- **`npx wrangler types`** generates `worker-configuration.d.ts`. Commit that file.

## Acceptance
```
npm run typecheck            # exit 0
npm test                     # both projects run, 2+ tests pass
npm run dev                  # open http://localhost:5173 -> Kumo button + 3-node Flow visible; /api/health -> {"ok":true,...}
npm run deploy               # succeeds; curl https://premise.<subdomain>.workers.dev/api/health -> {"ok":true,...}
```
`npm run dev` must work with `REPO_STORE=memory`. If the remote Artifacts binding makes `vite dev` fail without auth, note the Vite plugin's option for remote bindings in DECISIONS.md, and make sure dev still starts once you are logged in.

## Out of scope
- No real logic in the DOs or the Workflow yet.
- No UI design yet beyond the smoke render.
