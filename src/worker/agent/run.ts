// Drives one agent through plan, claim, work and submit. This is the whole of the agent's
// control flow; the Workflow class in workflow.ts only supplies durable steps.
import type { Assertion, Claim, CommitSha, Intent, IntentId, LedgerDecision, TaskDef } from "../../shared/types";
import { publish } from "../hub/publish";
import type { IntentApi } from "../intent/client";
import { IllegalTransition, type IntentAction } from "../intent/machine";
import { isStalemateAcrossShards, requestClaimsAcrossShards, shardsOf } from "../ledger/client";
import { assistantMessage, type LlmClient, type LlmMessage, toolCalls, type ToolResultBlock } from "../ports/llm";
import type { RepoStore } from "../ports/repo-store";
import { briefing, NUDGE, SYSTEM_PROMPT, WORK_PHASE_NOTE } from "./prompts";
import { type AgentEnv, callTool, commitChanges, createToolContext, type Phase, TOOLS, type ToolContext } from "./tools";

export interface AgentParams {
	intentId: IntentId;
	/** "fresh": a newly dispatched Intent. "rederive": the same Intent re-run on a fresh fork of the new trunk. */
	mode: "fresh" | "rederive";
	/** Which recorded script to replay when LLM="scripted". Defaults to one named after the task. */
	script?: string;
	/** Ledger priority. Lower numbers win contested symbols. */
	priority?: number;
}

/** The durable-step interface the driver needs. The Workflow provides it; tests pass a plain in-memory one. */
export interface Steps {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
	/** Resolves with the event's payload, or null if `timeout` passes first. */
	waitForEvent<T>(name: string, type: string, timeout: string): Promise<T | null>;
}

export interface AgentDeps {
	env: AgentEnv;
	store: RepoStore;
	intent: IntentApi;
	/** The model client for the next turn, given the conversation so far. */
	llm(intent: Intent, messages: readonly LlmMessage[]): LlmClient;
	/** What happens after the push: the post-push checker and the gate queue. */
	handOff(intent: Intent, commit: CommitSha): Promise<void>;
}

export type AgentOutcome =
	| { result: "submitted"; commit: CommitSha; turns: number; usage: { input: number; output: number } }
	| { result: "failed" | "stopped"; reason: string; turns: number; usage: { input: number; output: number } };

export const PLAN_TURNS = 12;
export const WORK_TURNS = 20;
export const MAX_CLAIM_ROUNDS = 6;
export const DEFAULT_PRIORITY = 5;
export const LEDGER_FREE = "ledger-free";
export const HUMAN_CHOICE = "human-choice";

/** Statuses in which the agent that owns this run should keep going. Anything else means someone else took over. */
const RUNNABLE: Record<AgentParams["mode"], readonly Intent["status"][]> = {
	fresh: ["planning", "claiming", "waiting", "working"],
	rederive: ["rederiving"],
};

interface LoadResult {
	intent: Intent;
	task?: Pick<TaskDef, "title" | "hints">;
	adoptable: Pick<Assertion, "id" | "description">[];
}

interface TurnResult {
	assistant: Extract<LlmMessage, { role: "assistant" }>;
	results: ToolResultBlock[];
	/** The tool call the driver has to answer itself. */
	signal?: { kind: "claim" | "submit"; toolUseId: string };
	stop: "continue" | "refusal" | "no-tool";
	usage: { input: number; output: number };
	/** Set when the Intent is no longer this run's to work on. */
	interrupted?: string;
}

class Stopped extends Error {}

/** One model turn: ask the model, then run the tools it called, in order. */
async function turn(ctx: ToolContext, deps: AgentDeps, mode: AgentParams["mode"], messages: readonly LlmMessage[], phase: Phase): Promise<TurnResult> {
	const intent = await deps.intent.get();
	if (!RUNNABLE[mode].includes(intent.status)) {
		return { assistant: { role: "assistant", content: [] }, results: [], stop: "continue", usage: { input: 0, output: 0 }, interrupted: `the Intent is ${intent.status}` };
	}
	const reply = await deps.llm(intent, messages).turn(SYSTEM_PROMPT, [...messages], TOOLS);
	const assistant = assistantMessage(reply) as TurnResult["assistant"];
	if (reply.stop === "refusal") {
		return { assistant, results: [], stop: "refusal", usage: reply.usage };
	}
	const calls = toolCalls(reply);
	if (calls.length === 0) {
		return { assistant, results: [], stop: "no-tool", usage: reply.usage };
	}

	ctx.phase = phase;
	const results: ToolResultBlock[] = [];
	let signal: TurnResult["signal"];
	for (const call of calls) {
		if (signal !== undefined) {
			results.push({ type: "tool_result", tool_use_id: call.id, content: "Not run: an earlier call in the same turn ended the phase. Call it again if you still need it.", is_error: true });
			continue;
		}
		if (call.inputError !== undefined) {
			results.push({ type: "tool_result", tool_use_id: call.id, content: `The input could not be read: ${call.inputError}. Send the tool input as a JSON object.`, is_error: true });
			continue;
		}
		const outcome = await callTool(ctx, call.name, call.input);
		if (outcome.signal !== undefined && !outcome.isError) {
			signal = { kind: outcome.signal, toolUseId: call.id };
			continue; // the driver supplies this call's result
		}
		results.push(outcome.isError ? { type: "tool_result", tool_use_id: call.id, content: outcome.text, is_error: true } : { type: "tool_result", tool_use_id: call.id, content: outcome.text });
	}
	return signal === undefined ? { assistant, results, stop: "continue", usage: reply.usage } : { assistant, results, signal, stop: "continue", usage: reply.usage };
}

function describeDecision(decision: LedgerDecision, claims: readonly Claim[]): string {
	const list = (symbols: readonly string[]) => (symbols.length > 0 ? symbols.join(", ") : "nothing");
	switch (decision.kind) {
		case "granted":
			return `Granted. You may change: ${list(claims.map((claim) => claim.symbol))}.`;
		case "split":
			return `Split with Intent ${decision.with}. You may change only: ${list(decision.proposal.mine)}. The other Intent keeps: ${list(decision.proposal.theirs)}; do not edit those.`;
		case "wait":
			return `Wait: Intent ${decision.on} is changing ${list(decision.symbols)}.`;
		case "depend":
			return `Depend: Intent ${decision.on} is changing the interface of ${list(decision.symbols)}. Your work builds on theirs.`;
	}
}

/**
 * Runs the agent to completion. Returns "submitted" once the work is pushed and handed off,
 * "failed" if the agent could not finish (the Intent is marked failed), or "stopped" if the
 * Intent was taken out of this run's hands, for example because a premise broke mid-work.
 */
export async function runAgent(deps: AgentDeps, params: AgentParams, steps: Steps): Promise<AgentOutcome> {
	const { env, store, intent: api } = deps;
	const fresh = params.mode === "fresh";
	const ctx = createToolContext(env, store, api, params.intentId);
	const usage = { input: 0, output: 0 };
	let turns = 0;

	/** Status changes only apply to a fresh run. A re-derive stays "rederiving" until the gate decides. */
	const act = async (action: IntentAction, note?: string): Promise<void> => {
		if (!fresh) {
			return;
		}
		try {
			await api.act(action, note);
		} catch (error) {
			if (error instanceof IllegalTransition) {
				throw new Stopped(`the Intent is ${error.from}`);
			}
			throw error;
		}
	};
	const fail = async (reason: string): Promise<AgentOutcome> => {
		await api.act({ a: "fail" }, reason).catch(() => undefined);
		return { result: "failed", reason, turns, usage };
	};

	try {
		const loaded = await steps.do("load", async (): Promise<LoadResult> => {
			const intent = await api.get();
			const [tasksJson, assertionsJson] = await Promise.all([store.readFile(intent.repo, intent.baseCommit, "premise/tasks.json"), store.readFile(intent.repo, intent.baseCommit, "premise/assertions.json")]);
			const task = (JSON.parse(tasksJson ?? "[]") as TaskDef[]).find((candidate) => candidate.id === intent.taskId);
			const adoptable = (JSON.parse(assertionsJson ?? "[]") as Assertion[]).map(({ id, description }) => ({ id, description }));
			return task === undefined ? { intent, adoptable } : { intent, task: { title: task.title, ...(task.hints ? { hints: task.hints } : {}) }, adoptable };
		});
		const messages: LlmMessage[] = [{ role: "user", content: briefing({ ...loaded, mode: params.mode }) }];

		/** Runs turns in one phase until the agent signals the end of it. Returns the signalling turn, or a reason it ended early. */
		const phaseLoop = async (phase: Phase, limit: number, wanted: "claim" | "submit"): Promise<{ done: TurnResult } | { failed: string } | { stopped: string }> => {
			for (let n = 1; n <= limit; n++) {
				const result = await steps.do(`${phase}-turn-${n}`, () => turn(ctx, deps, params.mode, messages, phase));
				if (result.interrupted !== undefined) {
					return { stopped: result.interrupted };
				}
				turns++;
				usage.input += result.usage.input;
				usage.output += result.usage.output;
				messages.push(result.assistant);
				if (result.stop === "refusal") {
					return { failed: "the model declined to continue" };
				}
				if (result.signal?.kind === wanted) {
					return { done: result };
				}
				messages.push(result.stop === "no-tool" ? { role: "user", content: NUDGE } : { role: "user", content: result.results });
			}
			return { failed: `the agent used all ${limit} ${phase} turns without ${wanted === "claim" ? "declaring its changes" : "submitting"}` };
		};

		// Plan: read, assert, then declare.
		const planned = await phaseLoop("plan", PLAN_TURNS, "claim");
		if ("stopped" in planned) {
			return { result: "stopped", reason: planned.stopped, turns, usage };
		}
		if ("failed" in planned) {
			return await fail(planned.failed);
		}
		await act({ a: "claim" });

		// Claim: ask the ledger, waiting or escalating as it says, until it is granted.
		let claimText: string | undefined;
		for (let round = 1; claimText === undefined; round++) {
			if (round > MAX_CLAIM_ROUNDS) {
				return await fail(`the ledger did not grant the claims after ${MAX_CLAIM_ROUNDS} rounds`);
			}
			const { decision, claims, stalemate } = await steps.do(`claim-${round}`, async () => {
				const intent = await api.get();
				const answer = await requestClaimsAcrossShards(env, { intentId: intent.id, claims: intent.claims, priority: params.priority ?? DEFAULT_PRIORITY, dependsOn: intent.dependsOn });
				await publish(env, { t: "claim.decision", id: intent.id, decision: answer, symbols: intent.claims.map((claim) => claim.symbol) });
				const other = answer.kind === "split" ? answer.with : undefined;
				const stuck = other !== undefined && (await isStalemateAcrossShards(env, intent.id, other, shardsOf(intent.claims.map((claim) => claim.symbol))));
				return { decision: answer, claims: intent.claims, stalemate: stuck };
			});

			if (decision.kind === "granted") {
				claimText = describeDecision(decision, claims);
			} else if (decision.kind === "split" && !stalemate) {
				// Accept the ledger's proposal: keep only what it left us.
				const mine = new Set(decision.proposal.mine);
				await steps.do(`accept-split-${round}`, async () => void (await api.setClaims(claims.filter((claim) => mine.has(claim.symbol)))));
				claimText = describeDecision(decision, claims);
			} else if (decision.kind === "split") {
				// The same two Intents keep splitting the same symbols. A person decides.
				await act({ a: "escalate" }, `Stalemate with Intent ${decision.with}`);
				await steps.do(`ask-human-${round}`, async () =>
					void (await publish(env, { t: "human.needed", id: params.intentId, kind: "stalemate", message: `${describeDecision(decision, claims)} The two Intents have split the same symbols twice.`, options: ["Wait", "Split", "Depend"] })),
				);
				const chosen = await steps.waitForEvent<{ choice?: string }>(`human-choice-${round}`, HUMAN_CHOICE, "24 hours");
				const choice = chosen?.choice ?? "Wait";
				await act({ a: "human", choice });
				if (choice === "Split") {
					const mine = new Set(decision.proposal.mine);
					await steps.do(`accept-split-${round}`, async () => void (await api.setClaims(claims.filter((claim) => mine.has(claim.symbol)))));
					claimText = describeDecision(decision, claims);
				} else {
					if (choice === "Depend") {
						await steps.do(`depend-${round}`, async () => void (await api.setDependsOn([...(await api.get()).dependsOn, decision.with])));
					}
					await act({ a: "wait" }, `Waiting on Intent ${decision.with}`);
					await steps.waitForEvent(`wait-ledger-${round}`, LEDGER_FREE, "30 minutes");
					await act({ a: "resume" });
				}
			} else {
				await act({ a: "wait" }, describeDecision(decision, claims));
				// Woken when another Intent lands or fails. If nothing arrives, ask again anyway.
				await steps.waitForEvent(`wait-ledger-${round}`, LEDGER_FREE, "30 minutes");
				await act({ a: "resume" });
			}
		}
		await act({ a: "granted" });
		messages.push({
			role: "user",
			content: [...planned.done.results, { type: "tool_result", tool_use_id: planned.done.signal?.toolUseId ?? "", content: `${claimText}\n${WORK_PHASE_NOTE}` }],
		});

		// Work: write, check, submit.
		const worked = await phaseLoop("work", WORK_TURNS, "submit");
		if ("stopped" in worked) {
			return { result: "stopped", reason: worked.stopped, turns, usage };
		}
		if ("failed" in worked) {
			return await fail(worked.failed);
		}

		// Push the work to the Intent's own fork.
		const commit = await steps.do("push", async () => {
			const intent = await api.get();
			const expected = intent.headCommit ?? intent.baseCommit;
			const head = await store.head(intent.repo);
			if (head !== expected) {
				// Only this run pushes to the fork, so a moved head means an earlier attempt at this step already pushed.
				return head;
			}
			const submitCall = worked.done.assistant.content.find((block) => block.type === "tool_use" && block.id === worked.done.signal?.toolUseId);
			const summary = submitCall?.type === "tool_use" && typeof submitCall.input.message === "string" ? submitCall.input.message : intent.goal;
			const sha = await store.commit(intent.repo, expected, commitChanges(intent, await api.overlay()), `intent ${intent.id}: ${summary}`);
			await publish(env, { t: "artifacts", type: "pushed", repo: intent.repo, detail: { commit: sha, intent: intent.id } });
			return sha;
		});
		await steps.do("record-push", async () => {
			if (fresh) {
				await act({ a: "submit", commit });
			} else {
				await api.setHead(commit);
			}
		});
		await steps.do("hand-off", async () => deps.handOff(await api.get(), commit));
		return { result: "submitted", commit, turns, usage };
	} catch (error) {
		if (error instanceof Stopped) {
			return { result: "stopped", reason: error.message, turns, usage };
		}
		const reason = error instanceof Error ? error.message : String(error);
		return await fail(`the agent run failed: ${reason.slice(0, 500)}`);
	}
}
