# T12: Dispatch API

## Goal
`POST /api/dispatch` turns tasks into running intents:
1. Freeze the acceptance checks.
2. Fork trunk.
3. Create the IntentDO.
4. Start the AgentWorkflow.

It also adds the public read APIs the UI needs.

## Read first
- `CLAUDE.md`
- `src/shared/types.ts`
- `src/worker/agent/workflow.ts`
- `src/worker/intent/intent-do.ts`
- `demo-repo/premise/tasks.json`

## Routes (`src/worker/routes/*.ts`, wired in `index.ts`)
- **`GET /api/tasks`.** Returns the parsed `tasks.json`, read from trunk through the RepoStore at `premise/tasks.json`.
- **`POST /api/dispatch`.** Body: `{ taskIds: TaskId[], priorityOrder?: TaskId[] }`. Admin token required. For each task, run these steps, with at most 6 tasks at a time:
  1. `id = newIntentId()`
  2. `base = await store.head("trunk")`
  3. `await store.fork("trunk", id)`
  4. Build an `Intent`:
     - `kind: "agent"`
     - `acceptance` deep-copied from the TaskDef, then `Object.freeze`-d
     - `status: "planning"`
     - `baseCommit: base`
     - `repo: id`
     - `rederiveAttempts: 0`
  5. `INTENT.get(idFromName(id)).init(intent)`
  6. `AGENT_WORKFLOW.create({ id: \`${id}-0\`, params: { intentId: id, mode: "fresh" } })`
  7. Return `{ intents: IntentId[] }`.
- **`GET /api/intents`.** Returns an index of every intent with its current status. Keep the list in a small registry in the EventHub DO (`registry` table, upserted on `intent.created` and `intent.status`), so you don't need to scan DOs.
- **`GET /api/intents/:id`.** Returns the full Intent from its DO.
- **`GET /api/ledger`.** Returns the merged `snapshot()` of all shards. Get the shard names from the registry of claimed shards, kept in the EventHub.
- **`POST /api/human/:id`.** Body: `{ choice }`. Sends a `human-choice` event to the intent's workflow instance and publishes `human.resolved`.
- **`POST /api/admin/reset-demo`.** Admin only. It:
  1. Deletes every fork whose name starts with `i`, using `store.remove`. Batch these, at most 20 at a time.
  2. Resets trunk to the original commit. Do this by re-importing into a fresh name (`trunk-<n>`) and pointing `TRUNK_REPO` at it through a KV-free mechanism: keep the "current trunk name" in the EventHub DO, and read it everywhere through `currentTrunk(env)`.
  3. Clears the events.

## Metrics
After each dispatch, publish a `metrics` event. Compute the metrics in one place, `src/worker/metrics.ts`, from the EventHub registry.

## Acceptance
```
npm test -- dispatch     # memory+scripted: dispatch 2 tasks -> 2 intents created, forks exist, workflows started, events published in order
npm run typecheck
# live (deployed, LLM=anthropic):
curl -X POST $URL/api/dispatch -H "x-admin-token: $T" -d '{"taskIds":["t04-session-ttl-header","t05-tax-rounding"]}'
curl $URL/api/intents      # both progress to queued/submitted within ~3 min
npx wrangler artifacts repos list --namespace premise   # forks visible (check exact flag with --help)
```
