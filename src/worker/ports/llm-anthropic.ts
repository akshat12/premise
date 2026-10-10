// Anthropic Messages API adapter, over plain fetch (the Worker has no Anthropic SDK dependency).
import type { AssistantBlock, LlmClient, LlmMessage, LlmTurn, ToolDef } from "./llm";
import { type HttpOptions, postJson } from "./llm-http";

export interface AnthropicOptions extends HttpOptions {
	apiKey: string;
	model: string;
	baseUrl?: string;
	maxTokens?: number;
	/** `output_config.effort`. Left out of the request when unset, so the model's own default applies. */
	effort?: string;
	/** Automatic prompt caching of the growing conversation prefix. On by default. */
	cache?: boolean;
}

const API_VERSION = "2023-06-01";

/** Our message shape is already Anthropic's, apart from the opaque `raw` and `inputError` fields. */
export function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
	return messages.map((message) => {
		if (message.role === "user") {
			return { role: "user", content: message.content };
		}
		// Send the turn back exactly as the API returned it. That keeps thinking blocks, which the
		// API requires to be replayed unchanged.
		if (Array.isArray(message.raw)) {
			return { role: "assistant", content: message.raw };
		}
		return {
			role: "assistant",
			content: message.content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : { type: "tool_use", id: block.id, name: block.name, input: block.input })),
		};
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a Messages API response. Blocks we do not act on (thinking and the like) stay only in `raw`. */
export function fromAnthropicResponse(response: unknown): LlmTurn {
	if (!isRecord(response) || !Array.isArray(response.content)) {
		throw new Error(`unexpected Anthropic response: ${JSON.stringify(response).slice(0, 500)}`);
	}
	const blocks: AssistantBlock[] = [];
	for (const block of response.content) {
		if (!isRecord(block)) {
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
			blocks.push(
				isRecord(block.input)
					? { type: "tool_use", id: block.id, name: block.name, input: block.input }
					: { type: "tool_use", id: block.id, name: block.name, input: {}, inputError: "the tool input was not an object" },
			);
		}
	}

	const reason = response.stop_reason;
	const stop: LlmTurn["stop"] =
		reason === "refusal" ? "refusal" : reason === "max_tokens" ? "max_tokens" : reason === "tool_use" || blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";

	const usage = isRecord(response.usage) ? response.usage : {};
	const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
	return {
		blocks,
		stop,
		// Cached tokens are reported separately from `input_tokens`; all three are input.
		usage: { input: count("input_tokens") + count("cache_creation_input_tokens") + count("cache_read_input_tokens"), output: count("output_tokens") },
		raw: response.content,
	};
}

export class AnthropicLlm implements LlmClient {
	constructor(private readonly options: AnthropicOptions) {}

	async turn(system: string, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn> {
		const body: Record<string, unknown> = {
			model: this.options.model,
			max_tokens: this.options.maxTokens ?? 16_000,
			system,
			messages: toAnthropicMessages(messages),
		};
		if (tools.length > 0) {
			body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }));
		}
		if (this.options.effort) {
			body.output_config = { effort: this.options.effort };
		}
		if (this.options.cache !== false) {
			// Each turn resends the whole conversation; caching the prefix makes that cheap.
			body.cache_control = { type: "ephemeral" };
		}
		const baseUrl = (this.options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
		const response = await postJson(`${baseUrl}/v1/messages`, { "x-api-key": this.options.apiKey, "anthropic-version": API_VERSION }, body, this.options);
		return fromAnthropicResponse(response);
	}
}
