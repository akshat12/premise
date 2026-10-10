// A live agent run: `runAgent` with a real model, against the in-memory demo repo. This is how a
// model is judged before it is trusted with the demo. Skipped unless LIVE_AGENT names a provider,
// so `npm test` never needs a key or the network.
//
//   LIVE_AGENT=google LIVE_MODEL=gemini-3.1-flash-lite LIVE_TASK=t07-role-check \
//     npx vitest run --project workers src/worker/agent/live.workers.test.ts --silent=false --reporter=verbose
//
// (Without the last two flags vitest does not show what a passing test printed.)
// The provider's key is read from the shell or from .dev.vars (vitest.config.ts forwards it).
// Optional: LIVE_TASK takes several ids separated by commas and runs them at the same moment;
// LIVE_EFFORT sets the reasoning effort; LIVE_DEADLINE_S (default 900) bounds each run;
// LIVE_FILES=1 also prints the files the agent wrote; LIVE_HINT adds one hint line to each task's
// briefing, to try a wording against a real model before it goes into tasks.json or the prompt.
//
// Output, one JSON object per line, each after a tag:
//   LIVE_HTTP    every model request: status, milliseconds, and the shape of the reply on the wire
//   LIVE_TURN    every model turn: the tool calls it made and what the previous calls returned
//   LIVE_RESULT  one per task: model, task, result, reason, turns, usage, seconds, and for the
//                whole run the HTTP requests sent, by status (so 429s and 503s can be counted)
//   LIVE_429     one of each kind of 429 body, in full: it names the quota that was hit and its limit
//
// `result` is the agent's own outcome: "submitted" means its own tests passed. Two fields judge the
// work from outside. `reference` runs the task's reference tests (premise/hidden-tests/, which
// the agent cannot see) against what it wrote. `overwrote` lists files that already existed and
// that it replaced without having claimed a symbol in them.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Intent, TaskDef } from "../../shared/types";
import { describeLlm, getLlm, type LlmClient, type LlmEnv, type LlmTurn, resolveLlmConfig, toolCalls } from "../ports/llm";
import { applyChanges } from "../ports/memory-repo-store";
import type { FileMap } from "../ports/repo-store";
import { runInIsolate } from "../runner";
import { memorySteps, seededStore, startIntent } from "../testing/agent";
import { demoFiles } from "../testing/demo";
import { handOff } from "./handoff";
import { type AgentDeps, type AgentOutcome, runAgent } from "./run";

const vars = env as unknown as Record<string, string | undefined>;
const provider = vars.LIVE_AGENT?.trim() ?? "";
const taskIds = (vars.LIVE_TASK ?? "t07-role-check").split(",").map((id) => id.trim()).filter((id) => id !== "");
const deadlineSeconds = Number(vars.LIVE_DEADLINE_S) > 0 ? Number(vars.LIVE_DEADLINE_S) : 900;
const llmEnv: LlmEnv = { ...vars, LLM: provider, ...(vars.LIVE_MODEL ? { LLM_MODEL: vars.LIVE_MODEL } : {}), ...(vars.LIVE_EFFORT ? { LLM_EFFORT: vars.LIVE_EFFORT } : {}) };

const log = (tag: string, value: unknown): void => console.log(`${tag} ${JSON.stringify(value)}`);
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}... [${text.length} chars]`);

/** The keys of a JSON value, with strings shown by length only. Shows what a provider attaches without printing it. */
function shapeOf(value: unknown, depth = 0): unknown {
	if (typeof value === "string") {
		return `string(${value.length})`;
	}
	if (Array.isArray(value)) {
		return depth > 5 ? "[...]" : value.slice(0, 4).map((item) => shapeOf(item, depth + 1));
	}
	if (typeof value === "object" && value !== null) {
		return depth > 5 ? "{...}" : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item, depth + 1)]));
	}
	return value;
}

interface HttpStats {
	/** Requests that were sent. */
	requests: number;
	/** How many replies had each status. */
	statuses: Record<string, number>;
	rateLimited: number;
	/** One 429 body of each kind, in full. Bodies that differ only in their numbers ("retry in 35s") count as one kind. */
	rateLimitBodies: Map<string, string>;
}

/**
 * Wraps `fetch` to count requests and keep what the provider said when it refused. Once a reply
 * says a per-day quota is used up, later requests are answered with that same reply without
 * being sent, so the other agents in the run do not each spend a request finding out.
 */
function countingFetch(inner: typeof fetch, stats: HttpStats): typeof fetch {
	let exhausted: { body: string } | undefined;
	return async (input, init) => {
		if (exhausted !== undefined) {
			stats.rateLimited++;
			return new Response(exhausted.body, { status: 429 });
		}
		const started = Date.now();
		stats.requests++;
		const response = await inner(input, init);
		const ms = Date.now() - started;
		stats.statuses[response.status] = (stats.statuses[response.status] ?? 0) + 1;
		if (response.ok) {
			const body: unknown = await response.clone().json().catch(() => null);
			const record = (typeof body === "object" && body !== null ? body : {}) as { choices?: { message?: unknown; finish_reason?: unknown }[]; usage?: unknown };
			log("LIVE_HTTP", { status: response.status, ms, finish: record.choices?.[0]?.finish_reason, message: shapeOf(record.choices?.[0]?.message), usage: record.usage });
			return response;
		}
		const body = await response.clone().text();
		log("LIVE_HTTP", { status: response.status, ms, retryAfter: response.headers.get("retry-after"), body: clip(body, 6000) });
		if (response.status === 429) {
			stats.rateLimited++;
			const kind = body.replace(/\d+(\.\d+)?/g, "#");
			if (!stats.rateLimitBodies.has(kind)) {
				stats.rateLimitBodies.set(kind, body);
			}
			if (/per[\s_-]?day/i.test(body)) {
				exhausted = { body };
			}
		}
		return response;
	};
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? clip(value, 160) : value]));
}

/** Logs each turn: what the tools called last turn answered, then what the model did. */
function tracing(inner: LlmClient, task: string): LlmClient {
	return {
		async turn(system, messages, tools): Promise<LlmTurn> {
			// The driver asks for a client on every turn, so the turn number comes from the conversation.
			const n = messages.filter((message) => message.role === "assistant").length + 1;
			const last = messages[messages.length - 1];
			const answers = last?.role === "user" && typeof last.content !== "string" ? last.content.map((result) => ({ error: result.is_error === true, text: clip(result.content, 300) })) : last?.role === "user" && n > 1 ? [{ error: false, text: clip(last.content as string, 300) }] : [];
			const started = Date.now();
			const reply = await inner.turn(system, messages, tools);
			log("LIVE_TURN", {
				task,
				n,
				ms: Date.now() - started,
				answers,
				stop: reply.stop,
				usage: reply.usage,
				text: reply.blocks.flatMap((block) => (block.type === "text" ? [clip(block.text, 200)] : [])),
				calls: toolCalls(reply).map((call) => ({ name: call.name, input: summarizeInput(call.input), ...(call.inputError ? { inputError: call.inputError } : {}) })),
			});
			return reply;
		},
	};
}

/** The demo repo with one more hint on every task, or unchanged when there is no hint. */
function withHint(files: FileMap, hint: string | undefined): FileMap {
	if (hint === undefined || hint.trim() === "") {
		return files;
	}
	const tasks = (JSON.parse(files["premise/tasks.json"] ?? "[]") as TaskDef[]).map((task) => ({ ...task, hints: [...(task.hints ?? []), hint.trim()] }));
	return { ...files, "premise/tasks.json": JSON.stringify(tasks, null, "\t") };
}

/** Runs the task's reference tests against the agent's version of the repo. */
async function referenceVerdict(taskId: string, files: FileMap, names: readonly string[]): Promise<{ passed: number; failed: string[] }> {
	const trunk = demoFiles();
	const source = trunk[`premise/hidden-tests/${taskId}.test.ts`];
	if (source === undefined) {
		return { passed: 0, failed: ["no reference tests for this task"] };
	}
	// The reference tests live two levels down. Re-point their imports so they run from tests/.
	// They get trunk's own copy of the shared test helpers, so this judges the source change alone;
	// an agent that damaged the helpers shows up under `overwrote`.
	const file = "tests/live-reference.test.ts";
	const support = "tests/live-reference-support.ts";
	const test = source.replaceAll("../../src/", "../src/").replaceAll('"../assert.js"', '"../premise/assert.js"').replaceAll('"../../tests/support.js"', '"./live-reference-support.js"');
	const run = await runInIsolate(env, { files: { ...files, [file]: test, [support]: trunk["tests/support.ts"] ?? "" }, tests: names.map((name) => ({ file, name })), assertions: [] });
	const failed = run.tests.flatMap((test) => (test.ok ? [] : [`${test.name}: ${clip(test.error ?? "failed", 200)}`]));
	return { passed: run.tests.filter((test) => test.ok).length, failed: run.loadError !== undefined && failed.length === 0 ? [clip(run.loadError, 300)] : failed };
}

describe.skipIf(provider === "")("live: an agent run with the provider named by LIVE_AGENT", () => {
	it("reaches the provider from the test pool", async () => {
		const config = resolveLlmConfig(llmEnv);
		if (!("wire" in config)) {
			throw new Error("LIVE_AGENT must name a real provider, not scripted");
		}
		// Listing models spends no generation quota. Any HTTP answer shows that outbound fetch works here.
		const response = await fetch(`${config.baseUrl}/models`, { headers: { authorization: `Bearer ${config.apiKey}` } });
		log("LIVE_PREFLIGHT", { ...describeLlm(llmEnv), status: response.status });
		expect(response.status).toBeLessThan(500);
	}, 60_000);

	it(
		`runs ${taskIds.join(", ")}`,
		async () => {
			const stats: HttpStats = { requests: 0, statuses: {}, rateLimited: 0, rateLimitBodies: new Map() };
			const client = getLlm(llmEnv);
			const originalFetch = globalThis.fetch;
			// The adapter looks `fetch` up when it is called, so this is seen without changing the adapter.
			globalThis.fetch = countingFetch(originalFetch.bind(globalThis), stats);
			const store = seededStore(withHint(demoFiles(), vars.LIVE_HINT));
			try {
				const results = await Promise.all(
					taskIds.map(async (taskId) => {
						const started = await startIntent(env, store, taskId);
						const deps: AgentDeps = { env, store, intent: started.api, llm: () => tracing(client, taskId), handOff: (intent, commit) => handOff(env, intent, commit, { store }) };
						const clock = Date.now();
						let cancel = (): void => undefined;
						const deadline = new Promise<AgentOutcome>((resolve) => {
							const timer = setTimeout(() => resolve({ result: "failed", reason: `no outcome after ${deadlineSeconds} s (harness deadline)`, turns: -1, usage: { input: 0, output: 0 } }), deadlineSeconds * 1000);
							cancel = () => clearTimeout(timer);
						});
						// Nothing lands in this harness, so an agent told to wait for another Intent is never woken.
						// Each wait takes a second, and the run then fails with the ledger's reason, not the model's.
						const steps = memorySteps(() => new Promise((resolve) => setTimeout(() => resolve(null), 1000)));
						const outcome = await Promise.race([runAgent(deps, { intentId: started.id, mode: "fresh" }, steps), deadline]);
						cancel();
						const seconds = Math.round((Date.now() - clock) / 100) / 10;
						const intent: Intent = await started.api.get();
						const overlay = await started.api.overlay();
						const written = Object.keys(overlay).sort();
						if (vars.LIVE_FILES) {
							for (const path of written) {
								log("LIVE_FILE", { task: taskId, path, content: overlay[path] });
							}
						}
						const trunk = demoFiles();
						const claimedPaths = new Set(intent.claims.map((claim) => claim.symbol.split("#")[0]));
						const reference = written.length === 0 ? null : await referenceVerdict(taskId, applyChanges(trunk, overlay), intent.acceptance.map((check) => check.testName));
						const summary = {
							model: describeLlm(llmEnv).model,
							effort: vars.LIVE_EFFORT ?? null,
							hint: vars.LIVE_HINT ?? null,
							task: taskId,
							result: outcome.result,
							reason: "reason" in outcome ? outcome.reason : null,
							turns: outcome.turns,
							usage: outcome.usage,
							seconds,
							status: intent.status,
							claims: intent.claims,
							asserted: intent.premises.filter((premise) => premise.source === "asserted").map((premise) => premise.assertion?.id ?? premise.symbol),
							written,
							overwrote: written.filter((path) => trunk[path] !== undefined && !claimedPaths.has(path)),
							reference,
						};
						await started.api.act({ a: "fail" }, "live run cleanup").catch(() => undefined);
						return summary;
					}),
				);
				for (const result of results) {
					log("LIVE_RESULT", { ...result, httpRequests: stats.requests, httpStatuses: stats.statuses, rateLimited: stats.rateLimited, concurrent: taskIds.length });
				}
				for (const body of stats.rateLimitBodies.values()) {
					log("LIVE_429", { body });
				}
				// The run is the measurement. The test only fails if nothing could be measured.
				expect(results).toHaveLength(taskIds.length);
			} finally {
				globalThis.fetch = originalFetch;
			}
		},
		(deadlineSeconds + 60) * 1000,
	);
});
