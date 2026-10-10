// Adapter for any endpoint that speaks OpenAI's chat-completions format with tools: OpenAI itself,
// Google Gemini's OpenAI endpoint, OpenRouter, Groq, Workers AI over REST, local servers.
// The three translation functions are pure, so a provider with the same message shape but a
// different transport (for example the Workers AI binding) can reuse them.
import type { AssistantBlock, LlmClient, LlmMessage, LlmTurn, ToolDef } from "./llm";
import { type HttpOptions, postJson } from "./llm-http";

export interface OpenAiCompatibleOptions extends HttpOptions {
	apiKey: string;
	model: string;
	/** Ends before `/chat/completions`, e.g. https://api.openai.com/v1 */
	baseUrl: string;
	maxTokens?: number;
	/** Sent as `reasoning_effort` when set. */
	effort?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toChatTools(tools: ToolDef[]): unknown[] {
	return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }));
}

export function toChatMessages(system: string, messages: LlmMessage[]): unknown[] {
	const out: unknown[] = [{ role: "system", content: system }];
	for (const message of messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				out.push({ role: "user", content: message.content });
			} else {
				// One "tool" message per result. There is no error flag in this format, so say it in the text.
				for (const result of message.content) {
					out.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.is_error ? `ERROR: ${result.content}` : result.content });
				}
			}
		} else if (isRecord(message.raw)) {
			// Send the provider's own assistant message back, so anything it attached to its tool
			// calls (Gemini's thought signatures, for one) survives.
			out.push(message.raw);
		} else {
			const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const calls = message.content.flatMap((block) =>
				block.type === "tool_use" ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
			);
			out.push(calls.length > 0 ? { role: "assistant", content: text === "" ? null : text, tool_calls: calls } : { role: "assistant", content: text });
		}
	}
	return out;
}

function parseArguments(raw: unknown): { input: Record<string, unknown>; error?: string } {
	if (isRecord(raw)) {
		return { input: raw }; // some servers return the arguments already parsed
	}
	if (typeof raw !== "string" || raw.trim() === "") {
		return { input: {} };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? { input: parsed } : { input: {}, error: "the tool arguments were not a JSON object" };
	} catch {
		return { input: {}, error: "the tool arguments were not valid JSON" };
	}
}

export function fromChatCompletion(response: unknown): LlmTurn {
	const choice = isRecord(response) && Array.isArray(response.choices) ? response.choices[0] : undefined;
	const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
	if (!isRecord(response) || !isRecord(choice) || message === undefined) {
		throw new Error(`unexpected chat-completions response: ${JSON.stringify(response).slice(0, 500)}`);
	}

	const blocks: AssistantBlock[] = [];
	if (typeof message.content === "string" && message.content !== "") {
		blocks.push({ type: "text", text: message.content });
	}
	const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	calls.forEach((call, index) => {
		const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
		if (!isRecord(call) || fn === undefined || typeof fn.name !== "string") {
			return;
		}
		const { input, error } = parseArguments(fn.arguments);
		const id = typeof call.id === "string" && call.id !== "" ? call.id : `call_${index}`;
		blocks.push(error === undefined ? { type: "tool_use", id, name: fn.name, input } : { type: "tool_use", id, name: fn.name, input, inputError: error });
	});

	const hasCalls = blocks.some((block) => block.type === "tool_use");
	const reason = choice.finish_reason;
	const stop: LlmTurn["stop"] = hasCalls ? "tool_use" : reason === "length" ? "max_tokens" : reason === "content_filter" ? "refusal" : "end_turn";

	const usage = isRecord(response.usage) ? response.usage : {};
	const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);

	// What we replay: only the fields every server accepts back on an assistant message.
	const raw: Record<string, unknown> = { role: "assistant", content: typeof message.content === "string" ? message.content : null };
	if (calls.length > 0) {
		raw.tool_calls = calls;
	}
	return { blocks, stop, usage: { input: count("prompt_tokens"), output: count("completion_tokens") }, raw };
}

export class OpenAiCompatibleLlm implements LlmClient {
	constructor(private readonly options: OpenAiCompatibleOptions) {}

	async turn(system: string, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn> {
		const body: Record<string, unknown> = {
			model: this.options.model,
			messages: toChatMessages(system, messages),
			max_completion_tokens: this.options.maxTokens ?? 16_000,
		};
		if (tools.length > 0) {
			body.tools = toChatTools(tools);
		}
		if (this.options.effort) {
			body.reasoning_effort = this.options.effort;
		}
		const baseUrl = this.options.baseUrl.replace(/\/+$/, "");
		const response = await postJson(`${baseUrl}/chat/completions`, { authorization: `Bearer ${this.options.apiKey}` }, body, this.options);
		return fromChatCompletion(response);
	}
}
