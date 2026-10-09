# T07: Type-surface hashing, surface diff and typecheck (TS Program in the Worker)

## Goal
Given a `FileMap` of the repo:
1. **Typecheck** it and return the errors.
2. Compute a **surface hash per exported symbol**, based on the declaration text emitted into `.d.ts`. That means signatures and types only, not bodies.
3. **Diff** two surface maps to find changed `SymbolId`s, including **transitive** changes. For example, if `type Session` changes, every exported function whose emitted declaration mentions `Session` changes too.

The gate (T15) and invalidation (T16) use this. It is the mechanism that keeps premises precise, so that internal refactors do not trigger false reds.

## Read first
- `CLAUDE.md`: TypeScript-in-Worker facts
- `docs/DECISIONS.md`: the T00 lib-loading approach (reuse it exactly)
- `src/worker/symbols/index.ts` (from T06)

## Files
`src/worker/surface/index.ts`, `src/worker/surface/libs.ts` (generated or loader-based), `scripts/gen-ts-libs.ts` (if T00 used generation), and `src/worker/surface/surface.test.ts`.

## API
```ts
export interface TypecheckResult { ok: boolean; errors: string[]; ms: number; }   // errors formatted "path:line: message"
export function typecheck(files: FileMap): TypecheckResult;

export type SurfaceMap = Map<SymbolId, { hash: string; decl: string }>;
export function surface(files: FileMap): { map: SurfaceMap; ms: number };

export function diffSurface(before: SurfaceMap, after: SurfaceMap): { changed: SymbolId[]; added: SymbolId[]; removed: SymbolId[] };
```

## Implementation notes
- Build one in-memory `CompilerHost` covering the repo files plus the lib `.d.ts` files.
- Compiler options:
  - `strict: true`
  - `target: ES2022`
  - `module: ESNext`
  - `moduleResolution: Bundler`
  - `lib: ["lib.es2022.d.ts"]`
  - `declaration: true`
  - `emitDeclarationOnly: true`
  - `skipLibCheck: true`
  - `noEmitOnError: false`
- Only include `src/**/*.ts` as root files. Do not include tests or `premise/`.
- **`typecheck`** uses `ts.getPreEmitDiagnostics(program)` and keeps only the diagnostics for repo files.
- **`surface`:**
  1. Emit the declarations, capturing them in `writeFile`.
  2. For each emitted `.d.ts`, parse it with `ts.createSourceFile`.
  3. For each exported declaration, take its printed text. Use `ts.createPrinter({ removeComments: true })` so that JSDoc changes do not change the surface hash.
  4. Normalize whitespace and hash with a fast non-crypto hash (FNV-1a 64 is fine).
- **Transitive closure.** Build a graph from the emitted declaration text: for each declaration, find which other exported type names it references, in the same file or through imports in the `.d.ts`. In `diffSurface`, take the directly changed symbols, then add every symbol that reaches a changed symbol through this graph. Keep iterating until nothing changes (fixed point).
- **Performance.** Measure `ms`. On the demo repo, `typecheck` plus `surface` should take under 3 seconds locally. If it takes longer, reuse one `ts.Program` for both: create the program once and pass it around.

## Tests
- Body-only change: `diffSurface` is empty.
- JSDoc-only change: empty. Comments are removed.
- Return type change: that symbol changes.
- A field added to `interface Session`: `Session` changes, plus `verifySession` (transitively), plus anything that returns `Session`.
- A parameter made optional: it changes.
- A new export is added.
- An export is removed.
- **The planted scenario.** Apply the t01 reference patch from T05. `diffSurface` must be EMPTY for `verifySession`, because the signature is unchanged. This proves the behavioural break is invisible to types, which is the whole point.
- `typecheck` on `demo-repo` gives `ok: true`. Introduce a type error and you get `ok: false`, with the error text naming the file.
- A test that runs in Workers (`*.workers.test.ts`) and calls `surface()` inside the workerd runtime, to prove it works there and not only in Node.

## Acceptance
```
npm test -- surface    # all pass, including the workers-pool test
npm run typecheck
```
