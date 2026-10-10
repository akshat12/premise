// Test support for anything that runs an agent: a seeded repo, an initialised Intent, and
// in-memory steps in place of a Workflow. Import this from tests only.
import { newIntentId } from "../../shared/ids";
import type { Intent, TaskDef } from "../../shared/types";
import type { AgentDeps, AgentParams, Steps } from "../agent/run";
import { AGENT_SCRIPTS, scriptKey } from "../agent/scripts";
import type { AgentEnv } from "../agent/tools";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { type LlmClient, type LlmTurn, ScriptedLlm } from "../ports/llm";
import { MemoryRepoStore } from "../ports/memory-repo-store";
import type { FileMap } from "../ports/repo-store";
import { demoFiles } from "./demo";

export const DEMO_TASKS: TaskDef[] = JSON.parse(demoFiles()["premise/tasks.json"] ?? "[]");

export function demoTask(id: string): TaskDef {
	const task = DEMO_TASKS.find((candidate) => candidate.id === id);
	if (task === undefined) {
		throw new Error(`no demo task ${id}`);
	}
	return task;
}

/** A memory store whose trunk is the demo repo (or the given files). */
export function seededStore(trunk: FileMap = demoFiles()): MemoryRepoStore {
	return new MemoryRepoStore({ trunk });
}

/** Forks trunk and creates the Intent for a demo task, as dispatch does. */
export async function startIntent(env: AgentEnv, store: MemoryRepoStore, taskId: string, overrides: Partial<Intent> = {}): Promise<{ id: string; api: IntentApi; intent: Intent }> {
	const task = demoTask(taskId);
	const id = newIntentId();
	const { head } = await store.fork("trunk", id);
	const api = intentStub(env, id);
	const intent = await api.init(newIntent({ id, kind: "agent", taskId: task.id, goal: task.goal, acceptance: structuredClone(task.acceptance), baseCommit: head, ...overrides }));
	return { id, api, intent };
}

/** Steps that run immediately and remember their names. `onWait` decides what a wait resolves to. */
export function memorySteps(onWait?: (name: string, type: string) => unknown | Promise<unknown>): Steps & { names: string[] } {
	const names: string[] = [];
	return {
		names,
		async do(name, fn) {
			names.push(name);
			// Round-trip through JSON, as a Workflow does when it persists a step result.
			const result = await fn();
			return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as never;
		},
		async waitForEvent(name, type) {
			names.push(`wait:${name}`);
			return ((await onWait?.(name, type)) ?? null) as never;
		},
	};
}

/** A model client that replays `turns`, picking up from however many turns the conversation already has. */
export function replay(turns: readonly LlmTurn[], label = "test"): AgentDeps["llm"] {
	return (_intent, messages): LlmClient => new ScriptedLlm(turns.slice(messages.filter((message) => message.role === "assistant").length), label);
}

/** The recorded script for a demo task. */
export function scriptFor(taskId: string, mode: AgentParams["mode"] = "fresh"): LlmTurn[] {
	const turns = AGENT_SCRIPTS[scriptKey({ taskId }, mode)];
	if (turns === undefined) {
		throw new Error(`no agent script for ${taskId} (${mode})`);
	}
	return turns;
}
