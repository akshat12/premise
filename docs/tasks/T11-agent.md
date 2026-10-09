# T11: Agent tools and AgentWorkflow (plan, claim, work, submit)

## Goal
A durable Workflow drives one LLM agent through four phases:

1. **Plan.** Read only. Every read records an **observed** premise.
2. **Claim.** The agent declares what it will change. The ledger decides the outcome.
3. **Work.** The agent edits files in an overlay.
4. **Submit.** The overlay is committed and pushed to the intent's fork.

Agents have **no shell**. The tools below are the only way they can see or touch code. That is what makes the premise capture complete.

## Read first
- `CLAUDE.md`
- `docs/vendor/cloudflare/workflows/build/`: `WorkflowEntrypoint`, `step.do`, `step.sleep`, `step.waitForEvent`, and `instance.sendEvent`. Check the exact current signatures there.
- `src/worker/ports/llm.ts`
- `src/worker/ports/repo-store.ts`
- `src/worker/intent/intent-do.ts`
- `src/worker/symbols/index.ts`
- `src/worker/surface/index.ts`
- `src/worker/ledger/client.ts`

## Tools: `src/worker/agent/tools.ts`
Each tool is a `ToolDef` plus a handler `(ctx, input) => Promise<string>`. The context is `ctx = { env, intentId, repo, ref, store, surfaceCache }`.

| Tool | Input | Behavior | Premise recorded |
|---|---|---|---|
| `list_files` | `{ dir?: string }` | Lists the paths in the fork at the intent's base. Hides `premise/`, `.intent/` and `tests/hidden*`. | none |
| `read_file` | `{ path }` | Returns the file text from the overlay if it has been edited, otherwise from the fork. | **observed**: every exported symbol in that file, with its surface hash from `surfaceCache` (computed once per base commit with `surface()`) |
| `search_symbols` | `{ query }` | Case-insensitive substring search over `indexRepo` names and paths. Returns at most 30 `SymbolId`s with their declaration line from the surface `decl`. | **observed**: each returned symbol (it saw the signature) |
| `read_symbol` | `{ symbol }` | Returns the source lines of just that symbol. | **observed**: that symbol |
| `assert_premise` | `{ description, code, imports[] }`, or `{ adopt: "a-session-throws" }` to adopt an assertion from `premise/assertions.json` | Stores an `Assertion`. | **asserted** |
| `declare_changes` | `{ claims: {symbol, mode}[], why: string[] (≤3), rejected?: string[] }` | Only allowed in the Claim phase. Calls the ledger. Returns the decision text. | none |
| `write_file` | `{ path, content }` | Only allowed in the Work phase. Writes to the overlay. | none |
| `run_checks` | `{}` | Only allowed in the Work phase. Builds the base snapshot plus the overlay, runs `typecheck`, and runs this intent's acceptance tests through the T14 runner (if T14 isn't ready yet, typecheck only). Returns a short report. | none |
| `submit` | `{ message }` | Only allowed in the Work phase. Ends the loop. | none |

Return errors as `is_error` tool results. Never throw out of the loop because of a bad tool input.

## Workflow: `src/worker/agent/workflow.ts`
Class `AgentWorkflow extends WorkflowEntrypoint<Env, { intentId: IntentId; mode: "fresh" | "rederive"; script?: string }>`.

1. `step.do("load")`: read the intent from its IntentDO.
2. `step.do("plan")`:
   - System prompt: `PLAN_PROMPT` (see below). The goal and the acceptance descriptions go in the user message.
   - Loop up to **12 turns**. Read tools only, plus `assert_premise` and `declare_changes`. The loop ends when `declare_changes` is called.
3. `step.do("claim")`:
   - **granted**: continue.
   - **wait** or **depend**: `act({a:"wait"})`, then `step.waitForEvent("ledger-free", { timeout: "30 minutes" })`, then `act({a:"resume"})`, then claim again.
   - **split**: accept the proposal (`setClaims(mine)`), then continue.
   - **Stalemate**: publish `human.needed` and wait for the `human-choice` event.
4. `step.do("work")`:
   - System prompt: `WORK_PROMPT`.
   - Loop up to **20 turns** with all tools except `declare_changes`.
   - The loop ends at `submit`. If the turns run out, fail.
5. `step.do("push")`:
   1. Call `store.commit(intent.repo, baseHead, overlay, message)`.
   2. Write `.intent/intent.json` in the same commit. It holds the Intent minus the overlay.
   3. Call `setHead`.
   4. Call `act({a:"submit", commit})`.
   5. Publish an `artifacts` event of type `pushed` for the fork. We emit this ourselves because the fork has no push subscription.
6. `step.do("hand-off")`: call the post-push checker. Until T13 exists, call `act({a:"check"})` and then `act({a:"queue"})`. After T13, call the checker function.

Every LLM turn is its own `step.do`, named `"plan-turn-<n>"` or `"work-turn-<n>"`. This makes retries durable and keeps steps small.

### Prompts: `src/worker/agent/prompts.ts`
Keep them short and literal. They must say:
- Reading tells the platform what you rely on.
- If your plan depends on a behaviour, not just a type, call `assert_premise`.
- Declare the **smallest** set of symbols you will change.
- Use `mode: "interface"` only if you will change an exported signature.
- Write at most three `why` lines.
- In the Work phase, call `run_checks` before `submit`.
- **Re-derive mode** adds a block to the prompt. It states which premises broke and why (from `brokenBy.reason`), the previous `why`, and the rejected alternatives. Then it says: "Trunk changed underneath you. Re-implement the same goal on the new trunk. The acceptance checks are unchanged."

## Tests
- **Unit tests for each tool handler**, using `MemoryRepoStore` seeded with `demo-repo`:
  - `read_file` records observed premises with the right symbols and hashes.
  - `write_file` is rejected in the Plan phase.
  - `adopt` loads the assertion from JSON.
- **Workers-pool end-to-end test:** `REPO_STORE=memory`, `LLM=scripted`. A script in `src/worker/agent/__scripts__/t04.json` performs: `read_file`, `declare_changes`, `write_file`, `run_checks`, `submit`. Run the Workflow, or call its step logic directly if Workflows are awkward in the test pool (note which in `DECISIONS.md`). Assert that the intent reaches `queued` (or `submitted`), that the fork head moved, and that `.intent/intent.json` exists in the fork.

## Acceptance
```
npm test -- agent
npm run typecheck
```
Plus a manual live check, if a key exists:
```
LLM=anthropic npm run dev
POST /api/admin/run-one {taskId:"t04-session-ttl-header"}   # (temporary admin route you add) -> watch events reach "submitted"
```
