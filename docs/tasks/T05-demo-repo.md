# T05: Demo target repo, tasks and the planted behavioural scenario

## Goal
Create `demo-repo/`, a realistic, pure-TypeScript service library that the agents work on. It must:
- Typecheck with `tsc`.
- Have tests that run in a Dynamic Worker: no Node APIs and no vitest, just our micro-harness.
- Contain the **planted behavioural premise break**, which is the core of the video.

Publish it to a public GitHub repo (MIT licence) and import it into Artifacts as `trunk`.

## Read first
- `docs/SPEC.md`: "The demo case"
- `src/shared/types.ts`: `TaskDef`, `AcceptanceCheck`, `Assertion`

## Repo shape: "acme-accounts", a small SaaS accounts and billing core
```
demo-repo/
  package.json        { "name": "acme-accounts", "type": "module", "scripts": { "typecheck": "tsc --noEmit", "test": "tsx premise/run-tests.ts" } }
  tsconfig.json       strict, ES2022, moduleResolution bundler, noEmit, lib ["es2022"] (NO dom, NO node types)
  LICENSE             MIT
  README.md           one paragraph: "Target repo for the Premise demo."
  src/
    util/   time.ts, ids.ts, hash.ts (pure-JS FNV/sha-ish), result.ts, errors.ts
    auth/   session.ts, token.ts, password.ts, rate-limit.ts, audit.ts, login.ts
    users/  user.ts, roles.ts, profile.ts, directory.ts
    billing/ plan.ts, invoice.ts, tax.ts, discount.ts, ledger.ts, currency.ts
    api/    routes.ts, handlers.ts, validate.ts, responses.ts
    store/  memory-store.ts, repo.ts
  tests/  one *.test.ts per area (≥ 8 files), each `export const tests: Record<string, () => void | Promise<void>> = {...}`
  premise/
    assert.ts         tiny assert lib: eq, ok, throws(fn, ErrorClass?), deepEq
    run-tests.ts      node runner (via tsx) that imports every tests/*.test.ts and runs them (for humans/CI)
    tasks.json        12 TaskDef entries (see below)
    assertions.json   pre-written Assertion objects agents may adopt (see below)
```
Targets:
- About 35–45 source files.
- About 200–300 exported symbols. Use real-looking code with JSDoc, not stubs.
- All tests pass.
- Everything is deterministic. Inject clocks (`now: () => number`). Never call `Date.now()` directly.

## The planted scenario (get it exactly right)
**`src/auth/session.ts`:**
```ts
export class SessionExpiredError extends Error { name = "SessionExpiredError"; }
export interface Session { id: string; userId: string; expiresAt: number; }
/** Returns null when no token is given. Throws SessionExpiredError when the session is expired. */
export function verifySession(token: string | undefined, store: SessionStore, now: () => number): Session | null { ... }
```

**`src/auth/login.ts`:** route logic that calls `verifySession`. It currently does `try { ... } catch (e) { if (e instanceof SessionExpiredError) return responses.expired(); throw e; }`.

The three tasks below are part of the 12 in `tasks.json`. Each uses `AcceptanceCheck`s that point at **tests the task's agent must add**. Put pre-written reference tests in `premise/hidden-tests/`. The A/B harness uses them later to detect behavioural regressions that reach trunk.

1. **`t01-null-expired` (the change that lands first).** "Make `verifySession` return null for expired sessions instead of throwing, so callers can treat 'no session' uniformly. Keep the signature unchanged."
   - tsc stays green, because the return type is already `Session | null`.
   - Its acceptance test checks that an expired token gives `null`.
2. **`t02-audit-expired` (in flight; relies on the throw).** "Write an audit log entry whenever a login request arrives with an expired session." The natural implementation adds `audit.record("session.expired")` inside the `catch (SessionExpiredError)` branch of `login.ts`.
   - Asserted premise: `verifySession throws SessionExpiredError for expired tokens`. This is in `premise/assertions.json` as `a-session-throws`.
   - Acceptance: expired session gives an audit entry plus an `expired` response.
   - **After t01 lands, a textual rebase of t02 merges cleanly and passes tsc. But its acceptance test fails**, because no exception means no audit entry. **A re-derive passes**, because the agent sees `null` and adds the audit call in the null branch.
3. **`t03-expired-metrics` (in flight; same reliance).** "Increment `metrics.sessionsExpired` when a request hits an expired session." Same failure pattern as t02.
4. **`t04-session-ttl-header` (in flight; relies on `verifySession` but not on the throw).** It reads `verifySession`, so it holds a type-surface premise. That premise does not break, because the surface is unchanged. **This shows that premises do not over-trigger.**

The other 8 tasks are independent, ordinary work spread across billing, users, api and util:
- tax rounding
- a discount stacking rule
- a role check helper
- profile validation
- currency formatting
- invoice numbering
- a rate-limit window
- a password policy

**Two of them must want the same symbol.** For example, both the discount and tax tasks touch `src/billing/invoice.ts#computeTotal`. That triggers a ledger Wait/Split.

## `premise/assertions.json`
```json
[{ "id": "a-session-throws", "description": "verifySession throws SessionExpiredError on expired tokens",
   "imports": ["src/auth/session.ts", "src/store/memory-store.ts"],
   "code": "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.throws(() => verifySession('s1', store, () => 10), SessionExpiredError);" }]
```
Match the real export names you create. An assertion's `code` can use `assert` and anything in its `imports`. The runner in T14 makes those available.

## Publish and import (HUMAN-assisted)
1. `cd demo-repo && git init && git add -A && git commit -m "acme-accounts: initial"`
2. Create a public repo with `gh repo create <user>/acme-accounts --public --source=. --push`. Ask the user to confirm the repo name first.
3. Add the route `POST /api/admin/import-trunk` (admin token) to the Worker. It calls `env.ARTIFACTS.import({ source: { url: "https://github.com/<user>/acme-accounts.git", branch: "main" }, target: { name: env.TRUNK_REPO } })`, then polls `list()` until the status is `ready`. Deploy, then call it.
4. HUMAN: create the event subscriptions. Check the exact `--events` names first with `npx wrangler queues subscription create --help` and `docs/vendor/cloudflare/queues/event-subscriptions/manage-event-subscriptions.mdx`:
   ```
   npx wrangler queues subscription create premise-events --source artifacts --events repo.created,repo.forked,repo.imported,repo.deleted --name premise-account
   npx wrangler queues subscription create premise-events --source artifacts.repo --events pushed --source-namespace premise --source-repo-name trunk --name premise-trunk-push
   ```
5. For local memory mode: `src/worker/ports/demo-seed.ts` bundles `demo-repo/**` as raw strings. Use Vite's `import.meta.glob("/demo-repo/**/*.{ts,json}", { query: "?raw", eager: true })`, or a generated file if globbing does not work in the worker environment. `MemoryRepoStore` then seeds `trunk` from it.

## Acceptance
```
cd demo-repo && npx tsc --noEmit && npx tsx premise/run-tests.ts   # all pass, prints count (≥ 40 tests)
node -e "const t=require('./demo-repo/premise/tasks.json'); if(t.length!==12) process.exit(1)"
# Scenario self-check, as a script: scripts/check-scenario.ts
#   1. Apply a reference t01 patch (premise/reference/t01.patch.ts, a FileChanges object) to a copy -> tsc passes, t01 test passes.
#   2. Apply the reference t02 patch on the ORIGINAL base -> t02 tests pass.
#   3. Apply t02 on top of t01 (textual) -> tsc passes AND the t02 acceptance test FAILS.   <- the whole demo depends on this
#   4. Apply reference t02-rederived patch on top of t01 -> passes.
npx tsx scripts/check-scenario.ts   # prints the 4 outcomes exactly as above
curl -X POST https://premise.<sub>.workers.dev/api/admin/import-trunk -H "x-admin-token: ..."   # -> ready; npx wrangler artifacts repos get trunk
```
