// The LLM port. Everything that talks to a model goes through `LlmClient`, so the provider is a
// configuration choice, not a code change. Adapters:
//   llm-anthropic.ts  Anthropic Messages API
//   llm-openai.ts     any OpenAI-compatible chat-completions endpoint (OpenAI, Google Gemini,
//                     OpenRouter, Groq, Workers AI over REST, a local server, ...)
//   llm-scripted.ts   recorded turns, for tests, local dev without keys, and demo replay
// To add a provider that speaks one of those two wire formats, add a row to PROVIDERS below.
// To add a new wire format, write one more adapter that implements `LlmClient`.
import { AnthropicLlm } from "./llm-anthropic";
import { OpenAiCompatibleLlm } from "./llm-openai";
import { ScriptedLlm } from "./llm-scripted";

export interface ToolDef {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export type AssistantBlock =
	| { type: "text"; text: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
			/** Set when the model's arguments could not be read (for example invalid JSON). The caller should answer with an error result. */
			inputError?: string;
	  };

export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type LlmMessage =
	| { role: "user"; content: string | ToolResultBlock[] }
	| {
			role: "assistant";
			content: AssistantBlock[];
			/**
			 * The provider's own form of this turn, exactly as it was returned. Adapters send it back
			 * verbatim instead of rebuilding the turn from `content`, because providers attach things
			 * that must survive the round trip (Claude's thinking blocks, Gemini's thought signatures).
			 * Treat it as opaque and never edit it.
			 */
			raw?: unknown;
	  };

export interface LlmTurn {
	blocks: AssistantBlock[];
	/** "refusal": the provider declined to answer. There is nothing to act on in `blocks`. */
	stop: "end_turn" | "tool_use" | "max_tokens" | "refusal";
	usage: { input: number; output: number };
	/** See `LlmMessage.raw`. */
	raw?: unknown;
}

export interface LlmClient {
	/**
	 * One model turn. Within a conversation, keep `system` and `tools` identical from call to call
	 * and only ever append to `messages`: some providers reject, and all providers cache worse on,
	 * a history that was edited.
	 */
	turn(system: string, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn>;
}

/** The message to append to the history after a turn. */
export function assistantMessage(turn: LlmTurn): LlmMessage {
	return turn.raw === undefined ? { role: "assistant", content: turn.blocks } : { role: "assistant", content: turn.blocks, raw: turn.raw };
}

export function toolCalls(turn: LlmTurn): Extract<AssistantBlock, { type: "tool_use" }>[] {
	return turn.blocks.filter((block): block is Extract<AssistantBlock, { type: "tool_use" }> => block.type === "tool_use");
}

/** scriptKey -> the turns to replay for it. */
export type ScriptedTurns = Record<string, LlmTurn[]>;

type Wire = "anthropic" | "openai-compatible";

interface ProviderPreset {
	wire: Wire;
	/** Base URL when LLM_BASE_URL is not set. Null means LLM_BASE_URL is required. */
	baseUrl: ((env: LlmEnv) => string) | null;
	/** Secrets to look in, in order. */
	keys: (keyof LlmEnv)[];
	/** Model when LLM_MODEL is not set, or is still a Claude id from another provider's config. */
	defaultModel?: string;
}

/**
 * The value of the `LLM` variable selects a row. Only "google" and "scripted" have been run end
 * to end. The rest are the same two adapters pointed at a different URL, and none of them,
 * "anthropic" included, has been run with a key.
 */
export const PROVIDERS: Record<string, ProviderPreset> = {
	anthropic: { wire: "anthropic", baseUrl: () => "https://api.anthropic.com", keys: ["LLM_API_KEY", "ANTHROPIC_API_KEY"], defaultModel: "claude-sonnet-5-5" },
	openai: { wire: "openai-compatible", baseUrl: () => "https://api.openai.com/v1", keys: ["LLM_API_KEY", "OPENAI_API_KEY"] },
	google: { wire: "openai-compatible", baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai", keys: ["LLM_API_KEY", "GEMINI_API_KEY"], defaultModel: "gemini-3.5-flash-lite" },
	openrouter: { wire: "openai-compatible", baseUrl: () => "https://openrouter.ai/api/v1", keys: ["LLM_API_KEY", "OPENROUTER_API_KEY"] },
	groq: { wire: "openai-compatible", baseUrl: () => "https://api.groq.com/openai/v1", keys: ["LLM_API_KEY", "GROQ_API_KEY"] },
	// Workers AI through its OpenAI-compatible REST endpoint. The key is a Cloudflare API token.
	"workers-ai": {
		wire: "openai-compatible",
		baseUrl: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID ?? ""}/ai/v1`,
		keys: ["LLM_API_KEY", "CLOUDFLARE_API_TOKEN"],
		defaultModel: "@cf/openai/gpt-oss-120b",
	},
	// Anything else that speaks chat completions: set LLM_BASE_URL.
	"openai-compatible": { wire: "openai-compatible", baseUrl: null, keys: ["LLM_API_KEY"] },
};

/** The slice of Env the LLM port reads. Every field is a plain string so tests can pass an object literal. */
export interface LlmEnv {
	LLM?: string;
	LLM_MODEL?: string;
	LLM_BASE_URL?: string;
	LLM_MAX_TOKENS?: string;
	LLM_EFFORT?: string;
	LLM_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	GEMINI_API_KEY?: string;
	OPENROUTER_API_KEY?: string;
	GROQ_API_KEY?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
}

export type LlmConfig =
	| { provider: "scripted" }
	| { provider: string; wire: Wire; baseUrl: string; apiKey: string; model: string; maxTokens: number; effort?: string };

export const DEFAULT_MAX_TOKENS = 16_000;

/** Works out which provider, URL, key and model to use. Throws a message that says what to set when something is missing. */
export function resolveLlmConfig(env: LlmEnv): LlmConfig {
	const provider = (env.LLM ?? "scripted").trim() || "scripted";
	if (provider === "scripted") {
		return { provider };
	}
	const preset = PROVIDERS[provider];
	if (preset === undefined) {
		throw new Error(`LLM="${provider}" is not a known provider. Use one of: scripted, ${Object.keys(PROVIDERS).join(", ")}.`);
	}

	const baseUrl = (env.LLM_BASE_URL?.trim() || preset.baseUrl?.(env) || "").replace(/\/+$/, "");
	if (baseUrl === "") {
		throw new Error(`LLM="${provider}" needs LLM_BASE_URL (the provider's OpenAI-compatible base URL, ending before /chat/completions).`);
	}

	const apiKey = preset.keys.map((name) => env[name]?.trim()).find((value) => value !== undefined && value !== "");
	if (apiKey === undefined) {
		throw new Error(`LLM="${provider}" needs an API key: set ${preset.keys.join(" or ")} in .dev.vars (local) or with \`wrangler secret put\` (deployed).`);
	}

	// A Claude model id left over from the default config is never right for another provider
	// (OpenRouter is the exception: it serves Claude under "anthropic/claude-...").
	const configured = env.LLM_MODEL?.trim();
	const leftover = configured !== undefined && configured.startsWith("claude-") && preset.wire !== "anthropic";
	const model = configured !== undefined && configured !== "" && !leftover ? configured : preset.defaultModel;
	if (model === undefined) {
		throw new Error(`LLM="${provider}" needs LLM_MODEL set to one of that provider's model ids${leftover ? ` (it is still "${configured}")` : ""}.`);
	}

	const maxTokens = Number(env.LLM_MAX_TOKENS);
	const effort = env.LLM_EFFORT?.trim();
	return {
		provider,
		wire: preset.wire,
		baseUrl,
		apiKey,
		model,
		maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
		...(effort ? { effort } : {}),
	};
}

/** What to show in health checks and logs. Never includes the key. */
export function describeLlm(env: LlmEnv): { provider: string; model?: string; baseUrl?: string } {
	const config = resolveLlmConfig(env);
	return "wire" in config ? { provider: config.provider, model: config.model, baseUrl: config.baseUrl } : { provider: config.provider };
}

/**
 * The LlmClient this deployment is configured for.
 * With LLM="scripted" it replays `script[scriptKey]`; a missing script replays nothing and
 * fails on the first turn with a message naming the key.
 */
export function getLlm(env: LlmEnv, script?: ScriptedTurns, scriptKey?: string): LlmClient {
	const config = resolveLlmConfig(env);
	if (!("wire" in config)) {
		return new ScriptedLlm(script?.[scriptKey ?? ""] ?? [], scriptKey);
	}
	return config.wire === "anthropic" ? new AnthropicLlm(config) : new OpenAiCompatibleLlm(config);
}

export { AnthropicLlm } from "./llm-anthropic";
export { LlmHttpError } from "./llm-http";
export { OpenAiCompatibleLlm } from "./llm-openai";
export { RecordingLlm, ScriptedLlm } from "./llm-scripted";
