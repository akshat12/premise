// Turning tasks into running Intents, and resetting everything for another demo run.
import { newIntentId } from "../shared/ids";
import type { Intent, IntentId, TaskDef, TaskId } from "../shared/types";
import { DEFAULT_PRIORITY } from "./agent/run";
import { workflowInstanceId } from "./agent/workflow";
import { currentTrunk, hub, publish, publishMetrics } from "./hub/publish";
import { intentStub, newIntent } from "./intent/client";
import { ledgerShard } from "./ledger/client";
import { getRepoStore } from "./ports";
import { isArtifactsError } from "./ports/artifacts-repo-store";
import { DEMO_REPO_FILES } from "./ports/demo-seed";
import { mapLimit } from "./ports/git-tree";
import { type RepoStore, ZERO_SHA } from "./ports/repo-store";

const DISPATCH_CONCURRENCY = 6;
const DELETE_CONCURRENCY = 20;

export class UnknownTasks extends Error {
	constructor(readonly taskIds: TaskId[]) {
		super(`unknown task id${taskIds.length === 1 ? "" : "s"}: ${taskIds.join(", ")}`);
		this.name = "UnknownTasks";
	}
}

/** The task list, read from trunk. */
export async function loadTasks(env: Env, store: RepoStore = getRepoStore(env)): Promise<TaskDef[]> {
	const text = await store.readFile(await currentTrunk(env), "main", "premise/tasks.json");
	return text === null ? [] : (JSON.parse(text) as TaskDef[]);
}

/** Position in `priorityOrder` (1 is highest), or the default for tasks it does not mention. */
export function priorityFor(taskId: TaskId, priorityOrder: readonly TaskId[] | undefined): number {
	const index = priorityOrder?.indexOf(taskId) ?? -1;
	return index === -1 ? DEFAULT_PRIORITY + (priorityOrder?.length ?? 0) : index + 1;
}

/**
 * For each task: fork trunk, create the Intent with its acceptance checks frozen, and start its
 * agent. Returns the new Intent ids in the order the tasks were given.
 */
export async function dispatchTasks(env: Env, taskIds: readonly TaskId[], priorityOrder?: readonly TaskId[]): Promise<IntentId[]> {
	const store = getRepoStore(env);
	const trunk = await currentTrunk(env);
	const tasks = await loadTasks(env, store);
	const unknown = taskIds.filter((id) => !tasks.some((task) => task.id === id));
	if (unknown.length > 0) {
		throw new UnknownTasks(unknown);
	}

	const ids = await mapLimit(taskIds, DISPATCH_CONCURRENCY, async (taskId) => {
		const task = tasks.find((candidate) => candidate.id === taskId) as TaskDef;
		const id = newIntentId();
		const { head } = await store.fork(trunk, id);
		await publish(env, { t: "artifacts", type: "forked", repo: id, detail: { source: trunk } });
		// The acceptance checks are copied here and never written again: IntentDO has no method that changes them.
		const acceptance = Object.freeze(structuredClone(task.acceptance)) as Intent["acceptance"];
		await intentStub(env, id).init(newIntent({ id, kind: "agent", taskId: task.id, goal: task.goal, acceptance, baseCommit: head, repo: id }));
		await env.AGENT_WORKFLOW.create({ id: workflowInstanceId(id, 0), params: { intentId: id, mode: "fresh", priority: priorityFor(taskId, priorityOrder) } });
		return id;
	});
	await publishMetrics(env);
	return ids;
}

/** Imports a git repo into Artifacts under `name` and waits until it is ready. */
export async function importRepo(env: Pick<Env, "ARTIFACTS">, name: string, url: string, attempts = 60): Promise<"ready" | "importing" | "forking" | "missing" | "exists"> {
	try {
		await env.ARTIFACTS.import({ source: { url, branch: "main" }, target: { name } });
	} catch (error) {
		if (isArtifactsError(error, { codes: ["ALREADY_EXISTS"], message: /already exists/i })) {
			return "exists";
		}
		throw error;
	}
	let status: "ready" | "importing" | "forking" | "missing" = "missing";
	for (let attempt = 0; attempt < attempts; attempt++) {
		let cursor: string | undefined;
		status = "missing";
		do {
			const page = await env.ARTIFACTS.list({ limit: 100, cursor });
			const found = page.repos.find((repo) => repo.name === name) as { status?: typeof status } | undefined;
			if (found !== undefined) {
				status = found.status ?? "ready";
				break;
			}
			cursor = page.cursor;
		} while (cursor);
		if (status === "ready") {
			return status;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return status;
}

export interface ResetResult {
	trunk: string;
	head: string;
	forksDeleted: number;
	previousTrunk: string;
}

/** True for a repo that belongs to an Intent: "i" plus 8 base36 characters, optionally "-r<n>" for a re-derive. */
export function isIntentRepo(name: string): boolean {
	return /^i[0-9a-z]{8}(-r\d+)?$/.test(name);
}

/**
 * Puts everything back to the start for another demo run: deletes every Intent fork, makes a
 * fresh copy of the demo repo as trunk under a new name, and clears the event log and the ledger.
 */
export async function resetDemo(env: Env): Promise<ResetResult> {
	const store = getRepoStore(env);
	const previousTrunk = await currentTrunk(env);
	const names = await store.list();

	const forks = names.filter(isIntentRepo);
	await mapLimit(forks, DELETE_CONCURRENCY, (name) => store.remove(name).catch(() => undefined));

	const trunk = `trunk-${Date.now().toString(36)}`;
	if (env.REPO_STORE === "memory") {
		await store.ensureRepo(trunk);
		await store.commit(trunk, ZERO_SHA, DEMO_REPO_FILES, "acme-accounts: initial");
	} else {
		const status = await importRepo(env, trunk, env.DEMO_REPO_URL);
		if (status !== "ready") {
			throw new Error(`the fresh trunk "${trunk}" is ${status}, not ready; the old trunk is still in use`);
		}
	}

	const shards = await hub(env).shards();
	await Promise.all(shards.map((shard) => ledgerShard(env, shard).clear()));
	await hub(env).setTrunk(trunk);
	await hub(env).reset();
	// Earlier reset copies are no longer needed. The original trunk repo is left alone.
	if (previousTrunk !== trunk && previousTrunk !== env.TRUNK_REPO) {
		await store.remove(previousTrunk).catch(() => undefined);
	}
	await publishMetrics(env);
	return { trunk, head: await store.head(trunk), forksDeleted: forks.length, previousTrunk };
}
