# T06: Symbol index and mapping diffs to symbols

## Goal
Write pure functions that, using the TypeScript compiler API's **parser only** (`ts.createSourceFile`, no Program):
1. List the exported symbols of each file, with their line ranges.
2. Map changed lines between two file versions to the `SymbolId`s they touched.
3. Find the identifiers a file references, resolved to `SymbolId`s through its imports. T13 uses this for "derived" premises.

## Read first
- `CLAUDE.md`
- `src/shared/types.ts` and `src/shared/ids.ts`
- `docs/DECISIONS.md`, for how T00 imported `typescript` inside the Worker

## Files
`src/worker/symbols/index.ts`, `src/worker/symbols/symbols.test.ts`, and fixtures in `src/worker/symbols/__fixtures__/`.

## API
```ts
export interface SymbolInfo {
  id: SymbolId;                // "src/auth/session.ts#verifySession"
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "let" | "var";
  startLine: number;           // 1-based, inclusive, covers JSDoc + declaration
  endLine: number;
  signatureEndLine: number;    // last line of the "interface part": for functions the line containing the opening "{" of the body; for interfaces/types/enums = endLine; for classes = line of the opening "{"; for consts = endLine
}
export function indexFile(path: string, text: string): SymbolInfo[];
export function indexRepo(files: FileMap): Map<SymbolId, SymbolInfo>;   // only *.ts, skip tests/ and premise/

export interface LineChange { oldStart: number; oldEnd: number; newStart: number; newEnd: number; } // 1-based inclusive; empty range = start > end
export function lineDiff(oldText: string, newText: string): LineChange[];  // simple LCS/Myers on lines; fine for files < 2k lines

export interface Touch { symbol: SymbolId; part: "body" | "interface"; }
/** Which exported symbols did this edit touch, and did it touch the interface part or only the body? New exports => interface touch on the new symbol. Removed exports => interface touch. */
export function touchedSymbols(path: string, oldText: string | null, newText: string | null): Touch[];

/** Imported names -> SymbolIds, resolving relative imports ("./x", "../y/z") to repo paths with ".ts". Ignores package imports. */
export function importMap(path: string, text: string): Map<string, SymbolId>;
/** All identifiers referenced inside the given line ranges that resolve via importMap or to same-file exports. */
export function referencedSymbols(path: string, text: string, ranges?: { start: number; end: number }[]): SymbolId[];
```

## Rules
- Only **exported** top-level declarations count. That includes `export function`, `export const`, `export class`, `export interface`, `export type`, `export enum`, and `export { a, b }` re-export lists that point at local declarations. `export default` becomes the name `default`.
- A `touchedSymbols` change counts as an **interface** touch when any changed line falls between `startLine` and `signatureEndLine` of the old or new symbol. A change that only touches lines after `signatureEndLine` is a **body** touch.
- A change to a non-exported helper that an exported function in the same file uses gives a body touch on every exported function in that file that calls it. Keep this simple: scan exported function bodies for the helper's name.
- Ignore whitespace-only line changes.

## Tests (at least 20 cases), using small fixture strings
- Function body edit gives body.
- Parameter rename gives interface.
- Return type change gives interface.
- JSDoc-only change gives interface. Document this choice in a comment. JSDoc is part of the surface the agent reads.
- New export gives interface on the new symbol.
- Deleted export gives interface.
- Edit to a private helper gives body on the callers.
- Interface field added gives interface.
- `export { x }` list.
- `importMap` resolves `../util/time` to `src/util/time.ts#now`.
- `referencedSymbols` finds `verifySession` used inside a function body.
- `indexRepo` on the whole `demo-repo/src` gives a count of 200 or more. Load the files from disk in the unit test.

## Acceptance
```
npm test -- symbols    # all pass
npm run typecheck
```
