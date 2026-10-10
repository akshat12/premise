import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { intentStub } from "../intent/client";
import { getRepoStore } from "../ports";
import { getLlm, type LlmClient, type LlmMessage, resolveLlmConfig, ScriptedLlm } from "../ports/llm";
import type { Intent } from "../../shared/types";
import { handOff } from "./handoff";
import { type AgentOutcome, type AgentParams, runAgent, type Steps } from "./run";
import { AGENT_SCRIPTS, scriptKey } from "./scripts";

/** The model client for a run. A scripted run replays from wherever the conversation has got to, so a restarted Workflow carries on with the right turn. */
export function llmFor(env: Env, params: AgentParams): (intent: Intent, messages: readonly LlmMessage[]) => LlmClient {
	if (resolveLlmConfig(env).provider !== "scripted") {
		const client = getLlm(env);
		return () => client;
	}
	return (intent, messages) => {
		const key = scriptKey(intent, params.mode, params.script);
		const played = messages.filter((message) => message.role === "assistant").length;
		return new ScriptedLlm((AGENT_SCRIPTS[key] ?? []).slice(played), key);
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
 * environment and makes each step durable.
 */
export class AgentWorkflow extends WorkflowEntrypoint<Env, AgentParams> {
	async run(event: WorkflowEvent<AgentParams>, step: WorkflowStep): Promise<AgentOutcome> {
		const params = event.payload;
		const env = this.env;
		return runAgent(
			{
				env,
				store: getRepoStore(env),
				intent: intentStub(env, params.intentId),
				llm: llmFor(env, params),
				handOff: (intent, commit) => handOff(env, intent, commit),
			},
			params,
			workflowSteps(step),
		);
	}
}

/** The Workflow instance id for a run: the Intent id plus the attempt number (0 for the first run). */
export function workflowInstanceId(intentId: string, attempt: number): string {
	return `${intentId}-${attempt}`;
}
