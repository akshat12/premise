import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { landing } from "../gate/client";
import { hub, withChosenLlm } from "../hub/publish";
import { intentStub } from "../intent/client";
import { getRepoStore } from "../ports";
import { getLlm, type LlmClient, type LlmMessage, type LlmTurn, RecordingLlm, resolveLlmConfig, ScriptedLlm } from "../ports/llm";
import type { Intent } from "../../shared/types";
import { handOff } from "./handoff";
import { type AgentOutcome, type AgentParams, runAgent, type Steps } from "./run";
import { AGENT_SCRIPTS, scriptKey } from "./scripts";
import { isPublicRunParams, type PublicRunParams, type PublicRunResult, runPublicRun } from "../live/start";
import { isWorkloadParams, runWorkloadIntent, type WorkloadParams, type WorkloadResult } from "../workload/run";

/** The model client for a run. A scripted run replays from wherever the conversation has got to, so a restarted Workflow carries on with the right turn. */
export function llmFor(env: Env, params: AgentParams): (intent: Intent, messages: readonly LlmMessage[]) => LlmClient {
	if (resolveLlmConfig(env).provider !== "scripted") {
		const client = getLlm(env);
		// A real model: keep each turn it returns, so the run can be saved and replayed as a script.
		return (intent, messages) => recordingTo(env, client, scriptKey(intent, params.mode), messages.filter((message) => message.role === "assistant").length);
	}
	return (intent, messages) => {
		const key = scriptKey(intent, params.mode, params.script);
		const played = messages.filter((message) => message.role === "assistant").length;
		return new ScriptedLlm((AGENT_SCRIPTS[key] ?? []).slice(played), key);
	};
}

/**
 * `client`, with each turn it returns also kept in the hub as turn `played` (then `played + 1`, ...)
 * of `script`. Keeping a turn is for demos; failing to must never cost the agent its run.
 */
export function recordingTo(env: Pick<Env, "HUB">, client: LlmClient, script: string, played: number): LlmClient {
	const sink: LlmTurn[] = [];
	const recorder = new RecordingLlm(client, sink);
	return {
		async turn(system, messages, tools) {
			const reply = await recorder.turn(system, messages, tools);
			const index = played + sink.length - 1;
			await hub(env)
				.recordTurn(script, index, JSON.stringify(sink.at(-1)))
				.catch(() => undefined);
			return reply;
		},
	};
}

const STEP_CONFIG = { retries: { limit: 2, delay: "2 seconds", backoff: "constant" }, timeout: "10 minutes" } as const;

/** Adapts Workflow steps to the plain interface the driver uses. */
export function workflowSteps(step: WorkflowStep): Steps {
	return {
		// The driver's step results are plain JSON, which is what Workflows can persist.
		do: (name, fn) => step.do(name, STEP_CONFIG, fn as () => Promise<never>) as Promise<never>,
		waitForEvent: async <T>(name: string, type: string, timeout: string) => {
			try {
				return (await step.waitForEvent(name, { type, timeout: timeout as never })).payload as T;
			} catch {
				return null; // timed out
			}
		},
	};
}

/**
 * One agent run for one Intent. All the logic is in run.ts; this class only wires in the
 * environment and makes each step durable. It also runs scripted workload Intents (workload/run.ts),
 * so that each of those gets an invocation of its own, and the start of a public run (live/start.ts),
 * so that it outlives the request that asked for it.
 */
export class AgentWorkflow extends WorkflowEntrypoint<Env, AgentParams | WorkloadParams | PublicRunParams> {
	async run(event: WorkflowEvent<AgentParams | WorkloadParams | PublicRunParams>, step: WorkflowStep): Promise<AgentOutcome | WorkloadResult | PublicRunResult> {
		const env = this.env;
		if (isPublicRunParams(event.payload)) {
			// A reset, a dispatch and a workload: each done once, never retried (see runPublicRun).
			return runPublicRun(env, event.payload, (name, fn) => step.do(name, { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" }, fn as () => Promise<never>) as Promise<never>);
		}
		if (isWorkloadParams(event.payload)) {
			// A scripted workload Intent: no model, one step. It never throws, so there is nothing to retry.
			const { job, trunk } = event.payload;
			return step.do("workload", { retries: { limit: 0, delay: "1 second" }, timeout: "10 minutes" }, async () => runWorkloadIntent(env, getRepoStore(env), job, { trunk }) as Promise<never>) as Promise<WorkloadResult>;
		}
		const params = event.payload as AgentParams;
		// The provider may have been chosen at run time; read it once, when the run starts.
		const chosen = await step.do("choose-model", async () => {
			const applied = await withChosenLlm(env);
			return { LLM: applied.LLM, LLM_MODEL: applied.LLM_MODEL };
		});
		const llm = llmFor({ ...env, ...chosen }, params);
		return runAgent(
			{
				env,
				store: getRepoStore(env),
				intent: intentStub(env, params.intentId),
				llm,
				handOff: (intent, commit) => handOff(env, intent, commit),
				instanceId: event.instanceId,
				// A re-derive that cannot finish tells the gate, which decides between another attempt and a person.
				giveUp: (reason) => landing(env).rederiveFailed(params.intentId, params.attempt ?? 0, reason),
			},
			params,
			workflowSteps(step),
		);
	}
}

export { workflowInstanceId } from "./instance";
