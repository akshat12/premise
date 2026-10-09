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
