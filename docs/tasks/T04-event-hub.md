# T04: EventHub (event log, WebSocket broadcast, replay) and the UI hook

## Goal
Build one Durable Object that every part of the backend calls to publish `PremiseEventBody` events. It:
- Assigns `seq` and `ts` to each event.
- Persists each event in SQLite.
- Broadcasts each event to connected browsers over a hibernatable WebSocket.

The UI subscribes with a React hook. The same hook can play a recorded JSON log, which gives deterministic demos and lets UI work start before the backend exists.

## Read first
- `CLAUDE.md`
- `src/shared/events.ts`
- `docs/vendor/cloudflare/durable-objects/best-practices/websockets.mdx`: the Hibernation API section
- `docs/vendor/cloudflare/durable-objects/api/`: SQL storage (`ctx.storage.sql`)

## Backend: `src/worker/hub/event-hub.ts`
- `class EventHub extends DurableObject`. Use exactly one instance: `env.HUB.idFromName("main")`.
- Table: `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, body TEXT)`. Create it in the constructor inside `ctx.blockConcurrencyWhile`.
- **RPC `publish(body: PremiseEventBody): Promise<PremiseEvent>`.**
  1. Insert the row.
  2. Build the event as `{ ...body, seq, ts }`.
  3. Broadcast it to every socket from `ctx.getWebSockets()`, using `ws.send(JSON.stringify(event))` inside try/catch.
  4. Return the event.
- **RPC `publishMany(bodies)`.** Does the same thing for a batch. Workload agents need this.
- **RPC `since(seq: number, limit = 5000): Promise<PremiseEvent[]>`**
- **RPC `reset()`.** Truncates the table. Used before demo runs.
- **`fetch(req)`** handles the WebSocket upgrade:
  1. `ctx.acceptWebSocket(server)`.
  2. Read `?since=N` from the URL and immediately send the events after N, as one JSON array message: `{ "backlog": [...] }`.
  3. Return `101`.
- **`webSocketMessage`.** Ignore incoming messages, except `"ping"`, which gets the reply `"pong"`.
- **Helper `src/worker/hub/publish.ts`.** Export `publish(env, body)` and `publishMany(env, bodies)`. All other code uses these.

## Routes (`src/worker/index.ts`)
- `GET /api/events/ws?since=N` forwards to the hub's `fetch`.
- `GET /api/events?since=N` returns JSON from `since()`. Useful for debugging and for recording a demo.
- `POST /api/admin/events/reset` resets the log. Requires the admin token.
- `POST /api/admin/events/fake` publishes a body passed as JSON. Requires the admin token. Useful for UI testing.

## UI: `src/ui/lib/useEventStream.ts`
```ts
export type StreamSource = { kind: "live"; url: string } | { kind: "replay"; events: PremiseEvent[]; speed: number };
export function useEventStream(source: StreamSource): { events: PremiseEvent[]; connected: boolean };
```
- **Live mode.**
  - Connect to the WebSocket, handle the `backlog` message, then append each event as it arrives.
  - Reconnect with backoff (1, 2, 4, then 8 seconds maximum), resuming from the last `seq`.
  - Send `"ping"` every 20 seconds.
- **Replay mode.**
  - Emit the events on a timer, preserving the gaps between their `ts` values divided by `speed`.
  - Skip `demo.marker` gaps.

## Reducer: `src/ui/lib/reduce.ts` (pure, unit-tested)
- Signature: `reduce(state: ViewState, e: PremiseEvent): ViewState`.
- `ViewState`:
  - `intents: Record<IntentId, IntentSummary & { lastNote?: string; race?: {...}; human?: {...} }>`
  - `trunk: { commit: string | null; landed: IntentId[] }`
  - `metrics: Metrics`
  - `ledger: Record<SymbolId, { writer?: IntentId; readers: IntentId[] }>`
  - `markers: string[]`
- Handle every event type in `events.ts`. An unknown type leaves the state unchanged.
- This reducer is the only UI state logic. The components in T20–T23 just render `ViewState`.

## Fixture: `src/ui/fixtures/sample-run.json`
Hand-write about 60 events that tell the demo story:
1. 12 intents are created.
2. Their claims and premises are recorded.
3. One `trunk.advanced` event touches `src/auth/session.ts#verifySession`.
4. Three `premise.broken` events follow.
5. A `rederive.race` sequence runs.
6. The intents land.
7. `metrics` updates appear throughout.

T20–T23 build against this fixture.

## Acceptance
```
npm test     # reduce.test.ts covers every event type; hub.workers.test.ts: publish -> since() returns it with seq 1; WebSocket client receives backlog + live event
npm run typecheck
npm run dev  # then: curl -X POST localhost:5173/api/admin/events/fake -H "x-admin-token: ..." -d '{"t":"demo.marker","label":"hi"}' ; curl localhost:5173/api/events -> contains it
```
