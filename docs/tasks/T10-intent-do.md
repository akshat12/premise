# T10: IntentDO (state machine and premise store)

## Goal
There is one Durable Object per intent. It owns the `Intent` record (types.ts), the file overlay the agent is editing, and the premise store. Every status change goes through a pure transition function and publishes an event.

## Read first
- `CLAUDE.md`
- `src/shared/types.ts` and `src/shared/events.ts`
- `src/worker/hub/publish.ts`
- `src/worker/ledger/client.ts`

## Pure state machine: `src/worker/intent/machine.ts`
```ts
export type IntentAction =
  | { a: "claim" } | { a: "granted" } | { a: "wait" } | { a: "resume" }
  | { a: "work" } | { a: "submit"; commit: CommitSha }
  | { a: "check" } | { a: "quarantine" } | { a: "upgrade-granted" }
  | { a: "queue" } | { a: "gate" } | { a: "land"; commit: CommitSha }
  | { a: "stale" } | { a: "rederive" } | { a: "escalate" } | { a: "fail" } | { a: "human"; choice: string };
export function transition(from: IntentStatus, action: IntentAction): IntentStatus; // throws IllegalTransition
```
Allowed edges (anything else throws):
```
planning -claim-> claiming
claiming -granted-> working   | -wait-> waiting   | -escalate-> escalated
waiting -resume-> claiming
working -submit-> submitted
submitted -check-> checking
checking -queue-> queued      | -quarantine-> quarantined
quarantined -upgrade-granted-> queued | -fail-> failed
queued -gate-> gating
gating -land-> landed         | -stale-> stale   | -fail-> failed
working|submitted|checking|queued -stale-> stale        (premise broke while in flight)
stale -rederive-> rederiving
rederiving -land-> landed     | -stale-> stale  | -escalate-> escalated
escalated -human-> claiming | rederiving | failed        (choice decides: "Split"/"Wait"/"Depend" -> claiming, "Retry" -> rederiving, "Abandon" -> failed)
any -fail-> failed
```

## Durable Object: `src/worker/intent/intent-do.ts`
Storage:
- The `Intent` as JSON under the key `intent`.
- The overlay as `FileChanges` under the key `overlay`.
- `premises` inside the `Intent`.

RPC methods (each persists, then publishes the matching event):
- `init(intent: Intent)`: publishes `intent.created`.
- `get(): Intent`
- `act(action: IntentAction, note?: string)`: calls `transition`, saves, then publishes `intent.status`. On `land`, `fail` or `abandon` it also calls `releaseEverywhere` on the ledger.
- `recordPremise(p: Premise)`
  - Dedupe by `(symbol, source)`.
  - Never downgrade `asserted`.
  - Publish `premise.recorded`.
  - Call the ledger shard's `subscribe` for symbols that have a surface hash.
- `breakPremise(symbol, by: { intentId, commit, reason })`: marks the premise `broken`, publishes `premise.broken`, then calls `act({a:"stale"})`, but only if the current status allows it.
- `setClaims(claims: Claim[])`, `setWhy(lines: string[])` (at most 3 lines, publishes `intent.why`), `addRejected(alt: string)`
- `writeOverlay(path, content | null)`, `readOverlay(path)`, `overlay()`
- `setHead(commit)`, `incRederive()`
- **Guard:** `acceptance` is set only in `init`. No method may change it. Add a test that proves this.

## Tests
- **`machine.test.ts`:** every allowed edge, plus at least 8 illegal transitions that throw.
- **Workers-pool test:** init, then `act` through the happy path to `landed`. Check that an event is published at each step; read them back through `HUB.since(0)`. Then `breakPremise` on a `working` intent: the status becomes `stale` and a `premise.broken` event is published.

## Acceptance
```
npm test -- intent
npm run typecheck
```
