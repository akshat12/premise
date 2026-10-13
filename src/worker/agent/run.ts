// Drives one agent through plan, claim, work and submit. This is the whole of the agent's
// control flow; the Workflow class in workflow.ts only supplies durable steps.
import type { Assertion, Claim, CommitSha, Intent, IntentId, IntentStatus, LedgerDecision, Premise, TaskDef } from "../../shared/types";
import { currentMode, hub, publish, waitTopic } from "../hub/publish";
import type { IntentApi } from "../intent/client";
import { IllegalTransition, type IntentAction } from "../intent/machine";
import { isStalemateAcrossShards, renewEverywhere, requestClaimsAcrossShards, shardsOf } from "../ledger/client";
import { assistantMessage, type LlmClient, type LlmMessage, toolCalls, type ToolResultBlock } from "../ports/llm";
import type { RepoStore } from "../ports/repo-store";
import { briefing, NUDGE, SYSTEM_PROMPT, WORK_PHASE_NOTE } from "./prompts";
import { HUMAN_CHOICE, LEDGER_FREE } from "./wake";
import { type AgentEnv, callTool, commitChanges, createToolContext, holding, type Phase, TOOLS, type ToolContext } from "./tools";

export interface AgentParams {
	intentId: IntentId;
	/** "fresh": a newly dispatched Intent. "rederive": the same Intent re-run on a fresh fork of the new trunk. */
	mode: "fresh" | "rederive";
	/** Which recorded script to replay when LLM="scripted". Defaults to one named after the task. */
	script?: string;
	/** Ledger priority. Lower numbers win contested symbols. */
	priority?: number;
	/**
	 * Re-derive only: which attempt this run is (the Intent's `rederiveAttempts` when it started).
	 * If the Intent has moved on to a later attempt, this run stops.
	 */
	attempt?: number;
	/** Re-derive only: the premises that broke, as they were before the Intent was pointed at its fresh fork. */
	broken?: Premise[];
	/** Re-derive only: why the earlier work did not land, when the gate rejected it. */
	reason?: string;
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
	/** This run's Workflow instance id, so it can be woken while it waits. Absent in tests that drive the run directly. */
	instanceId?: string;
	/**
	 * Re-derive only: called when the agent could not finish. The Intent is not failed; whoever
	 * started the re-derive decides whether it gets another attempt.
	 */
	giveUp?(reason: string): Promise<void>;
}

export type AgentOutcome =
	| { result: "submitted"; commit: CommitSha; turns: number; usage: { input: number; output: number } }
	| { result: "failed" | "stopped"; reason: string; turns: number; usage: { input: number; output: number } };

export const PLAN_TURNS = 16;
export const WORK_TURNS = 20;
/** How many times an agent asks the ledger before giving up. With the wait below, about 20 minutes. */
export const MAX_CLAIM_ROUNDS = 40;
/**
 * How long a waiting agent sleeps before asking the ledger again anyway. It is normally woken
 * sooner, when the Intent it waits on lands or fails; the short timeout covers a missed wake-up.
 */
export const LEDGER_WAIT = "30 seconds";
export const DEFAULT_PRIORITY = 5;
export { HUMAN_CHOICE, LEDGER_FREE } from "./wake";

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

/**
 * The statuses a first attempt passes through between its push being recorded and the gate having it:
 * a step that is retried in any of them carries on from there instead of giving up.
 */
const HANDED_ON: readonly Intent["status"][] = ["submitted", "checking", "quarantined", "queued"];

/** One model turn: ask the model, then run the tools it called, in order. */
/** Why this run should stop working on the Intent, or undefined if the Intent is still its to work on. */
function takenOver(intent: Intent, params: Pick<AgentParams, "mode" | "attempt">): string | undefined {
	if (params.mode === "rederive" && params.attempt !== undefined && intent.rederiveAttempts !== params.attempt) {
		return `re-derive attempt ${intent.rederiveAttempts} has taken over`;
	}
	return RUNNABLE[params.mode].includes(intent.status) ? undefined : `the Intent is ${intent.status}`;
}

async function turn(ctx: ToolContext, deps: AgentDeps, params: Pick<AgentParams, "mode" | "attempt">, messages: readonly LlmMessage[], phase: Phase): Promise<TurnResult> {
	const intent = await deps.intent.get();
	const interrupted = takenOver(intent, params);
	if (interrupted !== undefined) {
		return { assistant: { role: "assistant", content: [] }, results: [], stop: "continue", usage: { input: 0, output: 0 }, interrupted };
	}
	if (phase === "work" && intent.claims.length > 0) {
		// A claim lapses ten minutes after it was last renewed, so that a run that dies cannot hold a symbol
		// for ever. A run that is alive says so before every turn; a slow model then cannot lose its claims mid-work.
		await renewEverywhere(deps.env, intent.id, shardsOf(intent.claims.map((claim) => claim.symbol)));
	}
	const reply = await deps.llm(intent, messages).turn(SYSTEM_PROMPT, [...messages], TOOLS);
	const assistant = assistantMessage(reply) as TurnResult["assistant"];
	// A model turn can take a minute. If the Intent was taken over meanwhile (it went stale and a
	// re-derive started, say), the reply's tool calls must not touch files the new run is using.
	const meanwhile = takenOver(await deps.intent.get(), params);
	if (meanwhile !== undefined) {
		return { assistant: { role: "assistant", content: [] }, results: [], stop: "continue", usage: reply.usage, interrupted: meanwhile };
	}
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
	ctx.broken = params.mode === "rederive" ? (params.broken ?? []) : [];
	const usage = { input: 0, output: 0 };
	let turns = 0;

	/** Status changes only apply to a fresh run. A re-derive stays "rederiving" until the gate decides. */
	// Each change is a step of its own. Made outside one, it would be made again whenever the Workflow is
	// replayed (after a wait, or a restart), on an Intent that has moved on, and the run would stop there.
	let changes = 0;
	const act = async (action: IntentAction, note?: string): Promise<void> => {
		if (!fresh) {
			return;
		}
		const from = await steps.do(`status-${++changes}-${action.a}`, async (): Promise<IntentStatus | null> => {
			try {
				await api.act(action, note);
				return null;
			} catch (error) {
				if (error instanceof IllegalTransition) {
					return error.from;
				}
				throw error;
			}
		});
		if (from !== null) {
			throw new Stopped(`the Intent is ${from}`);
		}
	};
	/** Pauses until `type` arrives, having first noted in the hub what would wake this run. */
	const pause = async <T>(name: string, topic: string, type: string, timeout: string): Promise<T | null> => {
		const instanceId = deps.instanceId;
		if (instanceId !== undefined) {
			await steps.do(`note-${name}`, async () => void (await hub(env).addWaiter(instanceId, topic)));
		}
		return steps.waitForEvent<T>(name, type, timeout);
	};
	const fail = async (reason: string): Promise<AgentOutcome> => {
		// If the Intent has been taken out of this run's hands (it went stale and is being
		// re-derived, say), whatever went wrong here is no longer the Intent's problem.
		const current = await api.get().catch(() => null);
		// A first attempt is also still responsible while its push is being recorded and checked.
		const mine = current !== null && (takenOver(current, params) === undefined || (fresh && (current.status === "submitted" || current.status === "checking")));
		if (!mine) {
			return { result: "stopped", reason: `${reason} (and the Intent is ${current?.status ?? "gone"})`, turns, usage };
		}
		if (!fresh && deps.giveUp !== undefined) {
			// A re-derive that cannot finish is one failed attempt, not the end of the Intent.
			await steps.do("give-up", async () => void (await deps.giveUp?.(reason)));
		} else {
			await api.act({ a: "fail" }, reason).catch(() => undefined);
		}
		return { result: "failed", reason, turns, usage };
	};

	try {
		const loaded = await steps.do("load", async (): Promise<LoadResult> => {
			const intent = await api.get();
			const [tasksJson, assertionsJson] = await Promise.all([store.readFile(intent.repo, intent.baseCommit, "premise/tasks.json"), store.readFile(intent.repo, intent.baseCommit, "premise/assertions.json")]);
			const task = (JSON.parse(tasksJson ?? "[]") as TaskDef[]).find((candidate) => candidate.id === intent.taskId);
			// Only what is true of this fork is offered. After trunk moves, the library can hold a check that no longer passes.
			const adoptable = (await holding(env, (await ctx.base()).files, JSON.parse(assertionsJson ?? "[]") as Assertion[])).map(({ id, description }) => ({ id, description }));
			return task === undefined ? { intent, adoptable } : { intent, task: { title: task.title, ...(task.hints ? { hints: task.hints } : {}) }, adoptable };
		});
		// A re-derive is told what broke. Those premises were cleared from the Intent when it was
		// pointed at its fresh fork, so they come with the run's parameters.
		const briefed = params.mode === "rederive" && params.broken !== undefined ? { ...loaded.intent, premises: [...loaded.intent.premises, ...params.broken] } : loaded.intent;
		const messages: LlmMessage[] = [{ role: "user", content: briefing({ ...loaded, intent: briefed, mode: params.mode, ...(params.reason === undefined ? {} : { reason: params.reason }) }) }];

		/** Runs turns in one phase until the agent signals the end of it. Returns the signalling turn, or a reason it ended early. */
		const phaseLoop = async (phase: Phase, limit: number, wanted: "claim" | "submit"): Promise<{ done: TurnResult } | { failed: string } | { stopped: string }> => {
			for (let n = 1; n <= limit; n++) {
				const result = await steps.do(`${phase}-turn-${n}`, () => turn(ctx, deps, params, messages, phase));
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
				if ((await currentMode(env)) !== "premise") {
					// The comparison runs have no ledger: everyone simply edits what they like.
					return { decision: { kind: "granted" } as LedgerDecision, claims: intent.claims, stalemate: false };
				}
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
				const chosen = await pause<{ choice?: string }>(`human-choice-${round}`, waitTopic.human(params.intentId), HUMAN_CHOICE, "24 hours");
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
					await pause(`wait-ledger-${round}`, waitTopic.ledger(decision.with), LEDGER_FREE, LEDGER_WAIT);
					await act({ a: "resume" });
				}
			} else {
				await act({ a: "wait" }, describeDecision(decision, claims));
				// Woken when the other Intent lands or fails. If nothing arrives, ask again anyway.
				await pause(`wait-ledger-${round}`, waitTopic.ledger(decision.on), LEDGER_FREE, LEDGER_WAIT);
				await act({ a: "resume" });
			}
		}
		await act({ a: "granted" });
		const withdrawn = ctx.withdrawn.length > 0 ? `\nWithdrew your premise ${ctx.withdrawn.join(", ")}: you are changing that symbol, so you cannot also rely on how it behaves now.` : "";
		messages.push({
			role: "user",
			content: [...planned.done.results, { type: "tool_result", tool_use_id: planned.done.signal?.toolUseId ?? "", content: `${claimText}${withdrawn}\n${WORK_PHASE_NOTE}` }],
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
		// These steps answer with a value rather than throwing when the Intent has been taken over,
		// because a step that throws is retried, and what it throws does not come back as the same class.
		const pushed = await steps.do("push", async (): Promise<{ sha: CommitSha } | { stopped: string }> => {
			const intent = await api.get();
			const stopped = takenOver(intent, params);
			if (stopped !== undefined) {
				// The fork and the staged files may by now belong to a later attempt. Leave them alone.
				return { stopped };
			}
			const expected = intent.headCommit ?? intent.baseCommit;
			const head = await store.head(intent.repo);
			if (head !== expected) {
				// Only this run pushes to the fork, so a moved head means an earlier attempt at this step already pushed.
				return { sha: head };
			}
			const submitCall = worked.done.assistant.content.find((block) => block.type === "tool_use" && block.id === worked.done.signal?.toolUseId);
			const summary = submitCall?.type === "tool_use" && typeof submitCall.input.message === "string" ? submitCall.input.message : intent.goal;
			const sha = await store.commit(intent.repo, expected, commitChanges(intent, await api.overlay()), `intent ${intent.id}: ${summary}`);
			await publish(env, { t: "artifacts", type: "pushed", repo: intent.repo, detail: { commit: sha, intent: intent.id } });
			return { sha };
		});
		if ("stopped" in pushed) {
			return { result: "stopped", reason: pushed.stopped, turns, usage };
		}
		const commit = pushed.sha;
		const recorded = await steps.do("record-push", async (): Promise<{ stopped?: string }> => {
			const current = await api.get();
			// A retry of this step after the submit was already saved: there is nothing left to record. (Looked at
			// first: `takenOver` would read a first attempt that is already `submitted` as someone else's.)
			if (fresh && current.headCommit === commit && HANDED_ON.includes(current.status)) {
				return {};
			}
			const stopped = takenOver(current, params);
			if (stopped !== undefined) {
				return { stopped };
			}
			if (!fresh) {
				await api.setHead(commit);
				return {};
			}
			try {
				await api.act({ a: "submit", commit });
				return {};
			} catch (error) {
				if (error instanceof IllegalTransition) {
					return { stopped: `the Intent is ${error.from}` };
				}
				throw error;
			}
		});
		if (recorded.stopped !== undefined) {
			return { result: "stopped", reason: recorded.stopped, turns, usage };
		}
		await steps.do("hand-off", async () => {
			const intent = await api.get();
			// Hand over only what is still this run's: a first attempt with this push that has not reached the gate's
			// queue for certain (an earlier try of this step may have been cut short part-way), or the current re-derive.
			if (fresh ? intent.headCommit === commit && HANDED_ON.includes(intent.status) : takenOver(intent, params) === undefined) {
				await deps.handOff(intent, commit);
			}
		});
		return { result: "submitted", commit, turns, usage };
	} catch (error) {
		if (error instanceof Stopped) {
			return { result: "stopped", reason: error.message, turns, usage };
		}
		const reason = error instanceof Error ? error.message : String(error);
		return await fail(`the agent run failed: ${reason.slice(0, 500)}`);
	}
}
