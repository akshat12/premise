# T09: LlmClient (Anthropic adapter and ScriptedLlm)

## Goal
Build a minimal tool-calling LLM interface with two implementations:
- **`AnthropicLlm`**: real, uses the Messages API with tool use, through `fetch`.
- **`ScriptedLlm`**: deterministic. It replays recorded turns from JSON. Used for tests, local dev without keys, and the stage-demo fallback.

## Read first
- `CLAUDE.md`
- The Anthropic Messages API tool-use docs (fetch `https://docs.claude.com/en/docs/build-with-claude/tool-use/overview`). Check the current model ids and the request shape. Do not rely on memory.
- Optional: `docs/vendor/cloudflare/ai-gateway/usage/providers/anthropic*`, if you route through AI Gateway.

## Interface: `src/worker/ports/llm.ts`
```ts
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown>; }
export type LlmMessage =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };
export type AssistantBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface LlmTurn { blocks: AssistantBlock[]; stop: "end_turn" | "tool_use" | "max_tokens"; usage: { input: number; output: number } }
export interface LlmClient { turn(system: string, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn>; }
export function getLlm(env: Env, script?: ScriptedTurns): LlmClient;  // env.LLM === "scripted" -> ScriptedLlm
```

## AnthropicLlm
- `POST https://api.anthropic.com/v1/messages` with headers:
  - `x-api-key: env.ANTHROPIC_API_KEY`
  - `anthropic-version: 2023-06-01`
  - `content-type: application/json`
- Body: `model: env.LLM_MODEL`, `max_tokens: 4096`, `system`, `messages`, `tools`.
- Retries: on 429 and 529, retry up to 3 times with jittered backoff of 1, 2 and 4 seconds. On any other non-2xx status, throw an error that includes the response body.
- Optionally use an AI Gateway base URL from `env.AI_GATEWAY_URL`, if it is set.

## ScriptedLlm
- `type ScriptedTurns = Record<string /* scriptKey */, LlmTurn[]>`
- Construct it with `(turns: LlmTurn[])`. It returns the turns in order and throws when it runs out.
- **Recording helper:** `RecordingLlm(inner, sink)` wraps a real client and appends each turn to `sink`. T23 uses it to capture real runs for the stage fallback.

## Tests
- ScriptedLlm returns its turns in order and throws when exhausted.
- AnthropicLlm, with `fetch` mocked through vitest `vi.stubGlobal("fetch", ...)`:
  - correct headers and body shape
  - retry on 429
  - parses `tool_use` blocks
- An optional live test, skipped unless `ANTHROPIC_API_KEY` is set. It asks for a single tool call to `echo` and asserts the tool name.

## Acceptance
```
npm test -- llm
npm run typecheck
```
