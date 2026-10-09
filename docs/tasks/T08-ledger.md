# T08: LedgerShard Durable Object and the Wait / Split / Depend decision logic

## Goal
The ledger records two things for every symbol:
- Who intends to **change** it (claims).
- Who **relies on** it (read subscriptions, which come from premises).

It is sharded: there is one Durable Object per module directory (`moduleShard()` from T02). It answers two questions:
1. **Claim request:** "Can intent X change these symbols?" The answer is `granted`, `wait`, `split` or `depend`.
2. **Invalidation lookup:** "Who relies on these changed symbols?" This returns intent ids. T16 uses it.

## Read first
- `CLAUDE.md`
- `src/shared/types.ts`: `Claim`, `LedgerDecision`
- `src/shared/ids.ts`: `moduleShard`
- `docs/vendor/cloudflare/durable-objects/api/`: SQL storage and alarms

## Pure logic: `src/worker/ledger/decide.ts`
```ts
export interface HeldClaim { intentId: IntentId; symbol: SymbolId; mode: ClaimMode; since: number; priority: number; }
export interface ClaimRequest { intentId: IntentId; claims: Claim[]; priority: number; dependsOn: IntentId[]; }
export function decide(req: ClaimRequest, held: HeldClaim[]): LedgerDecision;
```
Decision table. Evaluate the rules in this order:
1. **Granted.** No held claim by another intent overlaps the requested symbols.
2. **Depend.** An overlap exists, and the other intent's claim on the overlapping symbol is `interface`, while this request only needs `body` on it. Return `{ kind: "depend", on: other, symbols }`. This means: wait for the other intent to land, then build on top of it.
3. **Split.** An overlap exists, and **both sides also hold or want at least one non-overlapping symbol**. Return `{ kind: "split", with: other, proposal }`, where the proposal gives the contested symbols to the higher-priority intent (lower number means higher priority; ties go to the earlier `since`) and keeps everything else with its owner.
4. **Wait.** Any other overlap. Return `{ kind: "wait", on: other, symbols }`.

When there are several conflicting intents, decide against the one with the highest priority (the lowest number). The decision is deterministic.

**Stalemate detection:** `isStalemate(a, b, history)` returns true when the same pair of intents has produced `split` twice without either of them landing. The caller turns that into a `human.needed` event (T22).

## Durable Object: `src/worker/ledger/ledger-shard.ts`
Tables:
- `claims(intent_id, symbol, mode, since, priority, expires_at)`
- `readers(intent_id, symbol, surface_hash)`

RPC methods:
- `requestClaims(req: ClaimRequest)`
  - Filter `req.claims` down to the symbols in this shard.
  - Call `decide`.
  - On `granted`, insert the rows with `expires_at = now + 10 min`, and set an alarm for the earliest expiry.
  - On `split`, insert only the `mine` part of the proposal. On `wait` or `depend`, insert nothing.
  - Return the decision.
- `renew(intentId)`: extend that intent's claims.
- `release(intentId)`: delete its claims and its readers. Called on land, fail or abandon.
- `subscribe(intentId, premises: { symbol, surfaceHash }[])`: upsert into `readers`.
- `readersOf(symbols: SymbolId[]): Promise<{ intentId, symbol, surfaceHash }[]>`
- `snapshot()`: returns all claims and readers, for the UI ledger rail and debugging.
- `alarm()`: deletes expired claims and publishes an `artifacts`-free note through `publish(env, { t: "intent.status", ... })`. Optional; keep it minimal.

## Multi-shard client: `src/worker/ledger/client.ts`
- `requestClaimsAcrossShards(env, req)`:
  1. Group the claims by shard.
  2. Call the shards **sequentially, in sorted shard order**. This ordering prevents deadlock.
  3. If any shard returns something other than `granted`, call `release` on the shards that already granted, then return that decision. In other words, the request is all-or-nothing.
- `readersAcrossShards(env, symbols)`: groups the symbols by shard, queries the shards in parallel, and merges the results.
- `releaseEverywhere(env, intentId, shards)`

## Tests
- **Unit tests on `decide`:** at least 12 cases covering every row of the table, priority ordering, tie-breaks, multiple conflicting intents, and an empty request.
- **Unit test on `isStalemate`.**
- **Workers-pool test:**
  1. Two intents request overlapping claims through `requestClaimsAcrossShards`. Expect `granted`, then a non-granted decision.
  2. Release, then the second request is granted.
  3. `subscribe` followed by `readersOf` returns the readers.

## Acceptance
```
npm test -- ledger
npm run typecheck
```
