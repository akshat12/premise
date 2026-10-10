import { describe, expect, it, vi } from "vitest";
import {
	AnthropicLlm,
	assistantMessage,
	describeLlm,
	getLlm,
	LlmHttpError,
	type LlmMessage,
	type LlmTurn,
	OpenAiCompatibleLlm,
	PROVIDERS,
	RecordingLlm,
	resolveLlmConfig,
	ScriptedLlm,
	toolCalls,
	type ToolDef,
} from "./llm";
import { fromAnthropicResponse, toAnthropicMessages } from "./llm-anthropic";
import { isRetryable, retryDelayMs } from "./llm-http";
import { fromChatCompletion, toChatMessages, toChatTools } from "./llm-openai";

const ECHO: ToolDef = { name: "echo", description: "Echo the text back.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const noSleep = async () => {};

interface Call {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** A fake fetch that answers with the given responses in order and records what it was sent. */
function fakeFetch(responses: (Response | Error)[]) {
	const calls: Call[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
		const next = responses.shift();
		if (next === undefined) {
			throw new Error("fakeFetch has no more responses");
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}) as typeof fetch;
	return { fetchFn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

const turn = (blocks: LlmTurn["blocks"], stop: LlmTurn["stop"] = "tool_use"): LlmTurn => ({ blocks, stop, usage: { input: 1, output: 1 } });

describe("ScriptedLlm", () => {
	it("returns its turns in order and throws when exhausted", async () => {
		const llm = new ScriptedLlm([turn([{ type: "text", text: "one" }], "end_turn"), turn([{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }])], "t04");
		expect(llm.remaining).toBe(2);
		expect((await llm.turn("s", [], [])).blocks).toEqual([{ type: "text", text: "one" }]);
		expect(toolCalls(await llm.turn("s", [], []))).toEqual([{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }]);
		await expect(llm.turn("s", [], [])).rejects.toThrow('script "t04" has 2 and turn 3 was requested');
	});

	it("says which script is missing when it has no turns", async () => {
		await expect(new ScriptedLlm([], "t99").turn("s", [], [])).rejects.toThrow('no turns for script "t99"');
	});

	it("hands out copies, so callers cannot change the script", async () => {
		const script = [turn([{ type: "tool_use", id: "t1", name: "echo", input: { text: "hi" } }])];
		const first = await new ScriptedLlm(script).turn("s", [], []);
		(first.blocks[0] as { input: Record<string, unknown> }).input.text = "changed";
		expect(await new ScriptedLlm(script).turn("s", [], [])).toEqual(script[0]);
	});
});

describe("RecordingLlm", () => {
	it("passes turns through and records them without the provider payload", async () => {
		const sink: LlmTurn[] = [];
		const inner = new ScriptedLlm([{ ...turn([{ type: "text", text: "hi" }], "end_turn"), raw: [{ type: "thinking", thinking: "", signature: "sig" }] }]);
		const result = await new RecordingLlm(inner, sink).turn("s", [], []);
		expect(result.raw).toBeDefined();
		expect(sink).toEqual([turn([{ type: "text", text: "hi" }], "end_turn")]);
		// What was recorded replays.
		expect(await new ScriptedLlm(sink).turn("s", [], [])).toEqual(sink[0]);
	});
});

describe("assistantMessage", () => {
	it("carries the provider payload only when there is one", () => {
		expect(assistantMessage(turn([{ type: "text", text: "a" }]))).toEqual({ role: "assistant", content: [{ type: "text", text: "a" }] });
		expect(assistantMessage({ ...turn([]), raw: ["x"] })).toEqual({ role: "assistant", content: [], raw: ["x"] });
	});
});

describe("HTTP retry policy", () => {
	it("retries rate limits, timeouts and server errors, and nothing else", () => {
		expect([408, 409, 429, 500, 502, 503, 529].every(isRetryable)).toBe(true);
		expect([400, 401, 402, 403, 404, 413, 422].some(isRetryable)).toBe(false);
	});

	it("backs off 1, 2, 4 seconds with jitter, or as long as the server asks", () => {
		expect([0, 1, 2, 3].map((attempt) => retryDelayMs(attempt, null, () => 1))).toEqual([1000, 2000, 4000, 4000]);
		expect(retryDelayMs(0, null, () => 0)).toBe(500);
		expect(retryDelayMs(0, "7", () => 0)).toBe(7000);
		expect(retryDelayMs(0, "600", () => 0)).toBe(30_000);
		expect(retryDelayMs(1, "soon", () => 1)).toBe(2000);
	});
});

const ANTHROPIC_TOOL_REPLY = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" },
		{ type: "text", text: "Echoing." },
		{ type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } },
	],
	stop_reason: "tool_use",
	usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 7 },
};

describe("AnthropicLlm", () => {
	const make = (responses: (Response | Error)[], extra: Record<string, unknown> = {}) => {
		const fake = fakeFetch(responses);
		return { ...fake, llm: new AnthropicLlm({ apiKey: "sk-test", model: "claude-sonnet-5-5", fetch: fake.fetchFn, sleep: noSleep, ...extra }) };
	};

	it("sends the documented headers and body", async () => {
		const { llm, calls } = make([json(ANTHROPIC_TOOL_REPLY)]);
		await llm.turn("You are terse.", [{ role: "user", content: "Say hi" }], [ECHO]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(calls[0]?.headers).toEqual({ "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" });
		expect(calls[0]?.body).toEqual({
			model: "claude-sonnet-5-5",
			max_tokens: 16_000,
			system: "You are terse.",
			messages: [{ role: "user", content: "Say hi" }],
			tools: [ECHO],
			cache_control: { type: "ephemeral" },
		});
	});

	it("parses text and tool_use blocks, and adds cached tokens to the input count", async () => {
		const { llm } = make([json(ANTHROPIC_TOOL_REPLY)]);
		const result = await llm.turn("s", [{ role: "user", content: "hi" }], [ECHO]);
		expect(result.blocks).toEqual([
			{ type: "text", text: "Echoing." },
			{ type: "tool_use", id: "toolu_1", name: "echo", input: { text: "hi" } },
		]);
		expect(result.stop).toBe("tool_use");
		expect(result.usage).toEqual({ input: 1110, output: 7 });
	});

	it("replays the assistant turn exactly as received, thinking block included", async () => {
		const { llm, calls } = make([json(ANTHROPIC_TOOL_REPLY), json({ ...ANTHROPIC_TOOL_REPLY, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" })]);
		const messages: LlmMessage[] = [{ role: "user", content: "Say hi" }];
		const first = await llm.turn("s", messages, [ECHO]);
		messages.push(assistantMessage(first), { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] });
		const second = await llm.turn("s", messages, [ECHO]);

		expect(second.stop).toBe("end_turn");
		expect(calls[1]?.body.messages).toEqual([
			{ role: "user", content: "Say hi" },
			{ role: "assistant", content: ANTHROPIC_TOOL_REPLY.content },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] },
		]);
	});

	it("builds the assistant turn from blocks when there is no provider payload, without our private fields", () => {
		const messages: LlmMessage[] = [{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "echo", input: { text: "x" }, inputError: "bad" }] }];
		expect(toAnthropicMessages(messages)).toEqual([{ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "t1", name: "echo", input: { text: "x" } }] }]);
	});

	it("passes tool errors through and omits optional fields that are not set", async () => {
		const { llm, calls } = make([json(ANTHROPIC_TOOL_REPLY)], { cache: false, effort: "medium", maxTokens: 2048, baseUrl: "https://gateway.example/anthropic/" });
		await llm.turn("s", [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true }] }], []);
		expect(calls[0]?.url).toBe("https://gateway.example/anthropic/v1/messages");
		expect(calls[0]?.body).toEqual({
			model: "claude-sonnet-5-5",
			max_tokens: 2048,
			system: "s",
			messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true }] }],
			output_config: { effort: "medium" },
		});
	});

	it("retries on 429 and 529, then succeeds", async () => {
		const sleeps: number[] = [];
		const fake = fakeFetch([json({ error: "rate" }, 429, { "retry-after": "2" }), json({ error: "overloaded" }, 529), json(ANTHROPIC_TOOL_REPLY)]);
		const llm = new AnthropicLlm({ apiKey: "k", model: "m", fetch: fake.fetchFn, sleep: async (ms) => void sleeps.push(ms), random: () => 1 });
		expect((await llm.turn("s", [{ role: "user", content: "hi" }], [])).stop).toBe("tool_use");
		expect(fake.calls).toHaveLength(3);
		expect(sleeps).toEqual([2000, 2000]);
	});

	it("retries a network error", async () => {
		const { llm, calls } = make([new TypeError("connection reset"), json(ANTHROPIC_TOOL_REPLY)]);
		await llm.turn("s", [{ role: "user", content: "hi" }], []);
		expect(calls).toHaveLength(2);
	});

	it("gives up after three retries", async () => {
		const { llm, calls } = make([429, 429, 429, 429, 429].map((status) => json({ error: "rate" }, status)));
		await expect(llm.turn("s", [{ role: "user", content: "hi" }], [])).rejects.toBeInstanceOf(LlmHttpError);
		expect(calls).toHaveLength(4);
	});

	it("does not retry a 400 and includes the response body in the error", async () => {
		const { llm, calls } = make([json({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: field required" } }, 400)]);
		const error = await llm.turn("s", [{ role: "user", content: "hi" }], []).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LlmHttpError);
		expect((error as LlmHttpError).status).toBe(400);
		expect((error as LlmHttpError).message).toContain("max_tokens: field required");
		expect(calls).toHaveLength(1);
	});

	it("maps stop reasons", () => {
		const reply = (stop_reason: string, content: unknown[] = [{ type: "text", text: "x" }]) => fromAnthropicResponse({ content, stop_reason, usage: {} });
		expect(reply("end_turn").stop).toBe("end_turn");
		expect(reply("max_tokens").stop).toBe("max_tokens");
		expect(reply("refusal", []).stop).toBe("refusal");
		expect(reply("pause_turn").stop).toBe("end_turn");
		expect(reply("stop_sequence").stop).toBe("end_turn");
		expect(reply("tool_use", [{ type: "tool_use", id: "t", name: "echo", input: {} }]).stop).toBe("tool_use");
		expect(() => fromAnthropicResponse({ type: "error" })).toThrow("unexpected Anthropic response");
	});

	it("works with a stubbed global fetch", async () => {
		const stub = vi.fn(async () => json(ANTHROPIC_TOOL_REPLY));
		vi.stubGlobal("fetch", stub);
		try {
			const result = await new AnthropicLlm({ apiKey: "k", model: "m" }).turn("s", [{ role: "user", content: "hi" }], [ECHO]);
			expect(toolCalls(result)[0]?.name).toBe("echo");
			expect(stub).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

const CHAT_TOOL_REPLY = {
	id: "chatcmpl-1",
	choices: [
		{
			index: 0,
			finish_reason: "tool_calls",
			message: {
				role: "assistant",
				content: null,
				refusal: null,
				tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"text":"hi"}' }, extra_content: { google: { thought_signature: "abc" } } }],
			},
		},
	],
	usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
};

describe("OpenAiCompatibleLlm", () => {
	const make = (responses: (Response | Error)[], extra: Record<string, unknown> = {}) => {
		const fake = fakeFetch(responses);
		return { ...fake, llm: new OpenAiCompatibleLlm({ apiKey: "sk-test", model: "gpt-x", baseUrl: "https://api.openai.com/v1/", fetch: fake.fetchFn, sleep: noSleep, ...extra }) };
	};

	it("sends a chat-completions request with function tools", async () => {
		const { llm, calls } = make([json(CHAT_TOOL_REPLY)]);
		await llm.turn("You are terse.", [{ role: "user", content: "Say hi" }], [ECHO]);
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(calls[0]?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sk-test" });
		expect(calls[0]?.body).toEqual({
			model: "gpt-x",
			messages: [
				{ role: "system", content: "You are terse." },
				{ role: "user", content: "Say hi" },
			],
			max_completion_tokens: 16_000,
			tools: [{ type: "function", function: { name: "echo", description: "Echo the text back.", parameters: ECHO.input_schema } }],
		});
	});

	it("parses tool calls and usage", async () => {
		const { llm } = make([json(CHAT_TOOL_REPLY)]);
		const result = await llm.turn("s", [{ role: "user", content: "hi" }], [ECHO]);
		expect(result.blocks).toEqual([{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } }]);
		expect(result.stop).toBe("tool_use");
		expect(result.usage).toEqual({ input: 20, output: 5 });
	});

	it("replays the provider's tool calls verbatim and sends results as tool messages", async () => {
		const { llm, calls } = make([json(CHAT_TOOL_REPLY), json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }], usage: {} })]);
		const messages: LlmMessage[] = [{ role: "user", content: "Say hi" }];
		const first = await llm.turn("s", messages, [ECHO]);
		messages.push(assistantMessage(first), {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "call_1", content: "hi" },
				{ type: "tool_result", tool_use_id: "call_2", content: "no such file", is_error: true },
			],
		});
		const second = await llm.turn("s", messages, [ECHO]);
		expect(second).toMatchObject({ blocks: [{ type: "text", text: "Done." }], stop: "end_turn" });
		expect(calls[1]?.body.messages).toEqual([
			{ role: "system", content: "s" },
			{ role: "user", content: "Say hi" },
			// The thought signature the provider attached comes back; fields like `refusal` do not.
			{ role: "assistant", content: null, tool_calls: CHAT_TOOL_REPLY.choices[0]?.message.tool_calls },
			{ role: "tool", tool_call_id: "call_1", content: "hi" },
			{ role: "tool", tool_call_id: "call_2", content: "ERROR: no such file" },
		]);
	});

	it("builds assistant messages from blocks when there is no provider payload", () => {
		const messages: LlmMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "c1", name: "echo", input: { text: "x" } }] },
			{ role: "assistant", content: [{ type: "text", text: "Plain." }] },
		];
		expect(toChatMessages("s", messages).slice(1)).toEqual([
			{ role: "assistant", content: "Looking.", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"text":"x"}' } }] },
			{ role: "assistant", content: "Plain." },
		]);
		expect(toChatTools([])).toEqual([]);
	});

	it("flags tool arguments that are not valid JSON instead of throwing", () => {
		const reply = (args: unknown) => fromChatCompletion({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ type: "function", function: { name: "echo", arguments: args } }] } }] });
		expect(reply('{"text": ').blocks).toEqual([{ type: "tool_use", id: "call_0", name: "echo", input: {}, inputError: "the tool arguments were not valid JSON" }]);
		expect(reply("[1,2]").blocks[0]).toMatchObject({ inputError: "the tool arguments were not a JSON object" });
		expect(reply({ text: "already parsed" }).blocks).toEqual([{ type: "tool_use", id: "call_0", name: "echo", input: { text: "already parsed" } }]);
		expect(reply("").blocks).toEqual([{ type: "tool_use", id: "call_0", name: "echo", input: {} }]);
	});

	it("maps finish reasons", () => {
		const reply = (finish_reason: string) => fromChatCompletion({ choices: [{ finish_reason, message: { content: "x" } }] }).stop;
		expect(reply("stop")).toBe("end_turn");
		expect(reply("length")).toBe("max_tokens");
		expect(reply("content_filter")).toBe("refusal");
		expect(() => fromChatCompletion({ error: { message: "bad" } })).toThrow("unexpected chat-completions response");
	});

	it("uses the same retry policy", async () => {
		const { llm, calls } = make([json({ error: "busy" }, 503), json(CHAT_TOOL_REPLY)], { effort: "low", maxTokens: 512 });
		await llm.turn("s", [{ role: "user", content: "hi" }], []);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.body).toMatchObject({ reasoning_effort: "low", max_completion_tokens: 512 });
		expect(calls[1]?.body.tools).toBeUndefined();
	});
});

describe("resolveLlmConfig and getLlm", () => {
	it("defaults to scripted, which needs no key", () => {
		expect(resolveLlmConfig({})).toEqual({ provider: "scripted" });
		expect(resolveLlmConfig({ LLM: "scripted", LLM_MODEL: "claude-sonnet-5-5" })).toEqual({ provider: "scripted" });
		expect(getLlm({ LLM: "scripted" }, { t04: [turn([], "end_turn")] }, "t04")).toBeInstanceOf(ScriptedLlm);
	});

	it("configures Anthropic from its own key or the generic one", () => {
		expect(resolveLlmConfig({ LLM: "anthropic", LLM_MODEL: "claude-sonnet-5-5", ANTHROPIC_API_KEY: "a" })).toEqual({
			provider: "anthropic",
			wire: "anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKey: "a",
			model: "claude-sonnet-5-5",
			maxTokens: 16_000,
		});
		expect(resolveLlmConfig({ LLM: "anthropic", ANTHROPIC_API_KEY: "a", LLM_API_KEY: "generic" })).toMatchObject({ apiKey: "generic", model: "claude-sonnet-5-5" });
		expect(getLlm({ LLM: "anthropic", ANTHROPIC_API_KEY: "a" })).toBeInstanceOf(AnthropicLlm);
	});

	it("switches provider by changing variables only", () => {
		expect(resolveLlmConfig({ LLM: "openai", LLM_MODEL: "gpt-x", OPENAI_API_KEY: "o" })).toMatchObject({ wire: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-x", apiKey: "o" });
		expect(resolveLlmConfig({ LLM: "google", GEMINI_API_KEY: "g" })).toMatchObject({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.8-flash" });
		expect(resolveLlmConfig({ LLM: "workers-ai", LLM_API_KEY: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" })).toMatchObject({ baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1", model: "@cf/openai/gpt-oss-120b" });
		expect(resolveLlmConfig({ LLM: "openai-compatible", LLM_BASE_URL: "http://localhost:11434/v1/", LLM_API_KEY: "x", LLM_MODEL: "local" })).toMatchObject({ baseUrl: "http://localhost:11434/v1", model: "local" });
		expect(getLlm({ LLM: "google", GEMINI_API_KEY: "g" })).toBeInstanceOf(OpenAiCompatibleLlm);
		expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "google", "groq", "openai", "openai-compatible", "openrouter", "workers-ai"]);
	});

	it("does not send a leftover Claude model id to another provider", () => {
		expect(resolveLlmConfig({ LLM: "google", LLM_MODEL: "claude-sonnet-5-5", GEMINI_API_KEY: "g" })).toMatchObject({ model: "gemini-3.8-flash" });
		expect(() => resolveLlmConfig({ LLM: "openai", LLM_MODEL: "claude-sonnet-5-5", OPENAI_API_KEY: "o" })).toThrow('needs LLM_MODEL set to one of that provider\'s model ids (it is still "claude-sonnet-5-5")');
		expect(resolveLlmConfig({ LLM: "openrouter", LLM_MODEL: "anthropic/claude-sonnet-5-5", LLM_API_KEY: "r" })).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
	});

	it("honours overrides for base URL, max tokens and effort", () => {
		const config = resolveLlmConfig({ LLM: "anthropic", ANTHROPIC_API_KEY: "a", LLM_BASE_URL: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/", LLM_MAX_TOKENS: "4096", LLM_EFFORT: "medium" });
		expect(config).toMatchObject({ baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic", maxTokens: 4096, effort: "medium" });
		expect(resolveLlmConfig({ LLM: "anthropic", ANTHROPIC_API_KEY: "a", LLM_MAX_TOKENS: "lots" })).toMatchObject({ maxTokens: 16_000 });
	});

	it("explains what is missing", () => {
		expect(() => resolveLlmConfig({ LLM: "anthropic" })).toThrow("needs an API key: set LLM_API_KEY or ANTHROPIC_API_KEY");
		expect(() => resolveLlmConfig({ LLM: "openai-compatible", LLM_API_KEY: "x", LLM_MODEL: "m" })).toThrow("needs LLM_BASE_URL");
		expect(() => resolveLlmConfig({ LLM: "bard" })).toThrow('LLM="bard" is not a known provider');
		expect(() => getLlm({ LLM: "groq", GROQ_API_KEY: "k" })).toThrow("needs LLM_MODEL");
	});

	it("describes the configuration without the key", () => {
		expect(describeLlm({ LLM: "anthropic", ANTHROPIC_API_KEY: "secret" })).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", baseUrl: "https://api.anthropic.com" });
		expect(JSON.stringify(describeLlm({ LLM: "anthropic", ANTHROPIC_API_KEY: "secret" }))).not.toContain("secret");
		expect(describeLlm({})).toEqual({ provider: "scripted" });
	});
});

// Live checks. Skipped unless a key is in the environment, so `npm test` never needs one.
//   ANTHROPIC_API_KEY=... npm test -- llm
//   LIVE_LLM=google GEMINI_API_KEY=... npm test -- llm
const processEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe.skipIf(!processEnv.ANTHROPIC_API_KEY)("live: Anthropic", () => {
	it("asks for a single tool call to echo", async () => {
		const llm = getLlm({ LLM: "anthropic", ANTHROPIC_API_KEY: processEnv.ANTHROPIC_API_KEY, LLM_MODEL: processEnv.LLM_MODEL });
		const result = await llm.turn("You are a test fixture. Always answer by calling the echo tool.", [{ role: "user", content: "Echo the word hello." }], [ECHO]);
		expect(toolCalls(result)[0]?.name).toBe("echo");
	}, 60_000);
});

describe.skipIf(!processEnv.LIVE_LLM)("live: the provider named by LIVE_LLM", () => {
	it("asks for a single tool call to echo, then accepts the result", async () => {
		const llm = getLlm({ ...processEnv, LLM: processEnv.LIVE_LLM });
		const system = "You are a test fixture. Always answer by calling the echo tool.";
		const messages: LlmMessage[] = [{ role: "user", content: "Echo the word hello." }];
		const first = await llm.turn(system, messages, [ECHO]);
		const call = toolCalls(first)[0];
		expect(call?.name).toBe("echo");
		messages.push(assistantMessage(first), { role: "user", content: [{ type: "tool_result", tool_use_id: call?.id ?? "", content: "hello" }] });
		expect((await llm.turn(system, messages, [ECHO])).stop).not.toBe("refusal");
	}, 120_000);
});
