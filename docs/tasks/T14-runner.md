# T14: Behavioural runner (repo tests and premise assertions in a Dynamic Worker)

## Goal
Given a `FileMap` and a list of things to run, return pass/fail per item. Two kinds of items:
- **Tests**: entries from a test file's exported `tests` object.
- **Assertions**: premise `Assertion`s.

Everything runs inside an isolated Dynamic Worker with `globalOutbound: null`.

## Read first
- `CLAUDE.md`: Dynamic Workers
- `docs/DECISIONS.md`: the T00 loader results, including the module naming and import rewriting scheme. Reuse it exactly.
- `spikes/src/index.ts`: the `/loader` route
- `demo-repo/premise/assert.ts` and the `demo-repo/tests/*.test.ts` format

## File: `src/worker/runner/index.ts`
```ts
export interface RunRequest { files: FileMap; tests: { file: string; name: string }[]; assertions: Assertion[]; cpuMs?: number; }
export interface RunResult {
  tests: { file: string; name: string; ok: boolean; error?: string; ms: number }[];
  assertions: { id: string; ok: boolean; error?: string; ms: number }[];
  loadError?: string;
}
export async function runInIsolate(env: Env, req: RunRequest): Promise<RunResult>;
export function buildModules(req: RunRequest): Record<string, string>;   // pure, unit-testable
```

## `buildModules`
1. Transpile every `src/**/*.ts`, `premise/assert.ts` and each test file that is needed with `ts.transpileModule`. Use `target: ES2022` and `module: ESNext`.
2. Rewrite relative import specifiers to the module keys, using the T00 scheme.
3. For each assertion, generate a module `__assert_<id>.js`. It must:
   - import `* as assert` from the assert module;
   - import every name from each of the assertion's `imports` modules (`import * as m0 from "..."`), then spread them: `const { verifySession, SessionExpiredError } = { ...m0, ...m1 }`;
   - export `run = async () => { <code> }`.
4. Generate the entry module `__runner.js`. It is a `WorkerEntrypoint` class `Runner` with `run()`. `run()`:
   - imports the needed test modules and assertion modules;
   - runs each item in turn with a timing;
   - catches errors per item and returns the `RunResult` shape.
5. Cache key: hash the module contents. The Loader's `get(id, cb)` can reuse isolates; read the Loader API docs and record your decision.

## `runInIsolate`
- Use `limits: { cpuMs: req.cpuMs ?? 5000 }`.
- Wrap the call in a wall-clock timeout of 20 seconds, using `Promise.race`.
- If the load fails because of a syntax error or a missing module, return `loadError` and mark every item failed.

## Tests (workers-pool, because the Loader works locally)
- The demo-repo baseline: every test in `tests/session.test.ts` passes.
- `a-session-throws` passes on the base.
- After applying the t01 reference patch:
  - `a-session-throws` **fails**;
  - the t01 acceptance test passes;
  - **the t02 acceptance test applied textually on top of t01 fails**. This is the same check as `scripts/check-scenario.ts`, but now in the isolate.
- An infinite loop in a test gets killed and reported as failed. The run does not hang.
- Code that calls `fetch` fails, because outbound is blocked.

## Acceptance
```
npm test -- runner
npm run typecheck
```
