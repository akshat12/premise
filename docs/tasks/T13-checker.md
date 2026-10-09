# T13: Post-push checker (out-of-claim edits and derived premises)

## Goal
After an intent pushes to its fork, the checker does three things:
1. Finds which symbols the push touched (from T06).
2. Quarantines the intent if it touched a symbol it never claimed. It also requests a claim upgrade automatically.
3. Records **derived** premises: every symbol the changed code references. This is the floor that guarantees premise capture even if an agent reasoned from memory.

Artifacts has no pre-receive hook, so the checker runs **after** the push. Pushes to the fork never touch trunk, and the gate (T15) is the real guarantee.

## Read first
- `CLAUDE.md`
- `src/worker/symbols/index.ts`
- `src/worker/surface/index.ts`
- `src/worker/ledger/client.ts`
- `src/worker/intent/intent-do.ts`

## File: `src/worker/gate/checker.ts`
```ts
export interface CheckResult { touched: Touch[]; outOfClaim: SymbolId[]; derived: SymbolId[]; }
export function checkPush(base: FileMap, head: FileMap, claims: Claim[]): CheckResult;   // pure
export async function runChecker(env: Env, intentId: IntentId): Promise<void>;          // effectful wrapper
```

## Pure logic: `checkPush`
1. Compute the changed files between `base` and `head`, ignoring `.intent/`.
2. Collect `touchedSymbols` for every changed file.
3. Decide `outOfClaim`. A touch is out of claim when:
   - its symbol has no claim, or
   - it is an `interface` touch but the claim is `body`.
4. Collect `derived` symbols. For each changed file, call `referencedSymbols(path, headText, changedRanges)`. Drop the symbols the intent itself changes, then dedupe.

## `runChecker` steps
1. `act({a:"check"})`.
2. Load base and head snapshots through the RepoStore, at the intent's `baseCommit` and `headCommit`.
3. Run `checkPush`. Publish `push.checked`.
4. Record every derived symbol as a **derived** premise:
   - Take its surface hash from `surface(base)`.
   - Cache the base surface by commit sha in memory, plus in the IntentDO if it is small.
   - Skip symbols that already have an observed premise.
5. Handle the result:
   - **If `outOfClaim` is non-empty:**
     1. `act({a:"quarantine"})`.
     2. Request an upgrade with `requestClaimsAcrossShards`, using the extra claims.
     3. If granted: `setClaims(all)`, then `act({a:"upgrade-granted"})`.
     4. Otherwise publish `human.needed` with kind `"stalemate"` and options `["Wait", "Split", "Depend"]`.
   - **Otherwise:** `act({a:"queue"})`. Then call `LANDING.get(idFromName("trunk")).enqueue(intentId)`. Until T15 exists, use a stub.

Replace the T11 hand-off stub with `runChecker`.

## Tests (unit, using fixtures from demo-repo)
- An edit that stays within its claims gives `outOfClaim: []`.
- Editing a helper in another file gives that symbol as out of claim.
- A body claim with a signature change gives out of claim (interface vs body).
- The t02 reference patch gives `derived` including `src/auth/session.ts#verifySession` and `SessionExpiredError`.
- `.intent/intent.json` changes are ignored.

## Acceptance
```
npm test -- checker
npm run typecheck
```
