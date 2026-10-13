// Turning tasks into running Intents, and resetting everything for another demo run.
import { newIntentId } from "../shared/ids";
import type { RunSummary } from "../shared/runs";
import type { Intent, IntentId, TaskDef, TaskId } from "../shared/types";
import { DEFAULT_PRIORITY } from "./agent/run";
import { landing } from "./gate/client";
import { workflowInstanceId } from "./agent/instance";
import { currentTrunk, hub, publish, publishMetrics } from "./hub/publish";
import { intentStub, newIntent } from "./intent/client";
import { ledgerShard } from "./ledger/client";
import { getRepoStore } from "./ports";
import { isArtifactsError } from "./ports/artifacts-repo-store";
import { DEMO_REPO_FILES } from "./ports/demo-seed";
import { mapLimit } from "./ports/git-tree";
import { type RepoStore, ZERO_SHA } from "./ports/repo-store";
import { release } from "./ports/release";

const DISPATCH_CONCURRENCY = 6;
const DELETE_CONCURRENCY = 20;

export class UnknownTasks extends Error {
	constructor(readonly taskIds: TaskId[]) {
		super(`unknown task id${taskIds.length === 1 ? "" : "s"}: ${taskIds.join(", ")}`);
		this.name = "UnknownTasks";
	}
}

/** Some tasks could not be started. The ones in `started` are running. */
export class DispatchFailed extends Error {
	constructor(
		readonly started: IntentId[],
		readonly failed: { taskId: TaskId; error: string }[],
	) {
		super(`could not start ${failed.length} of ${started.length + failed.length} task${started.length + failed.length === 1 ? "" : "s"}: ${failed.map((item) => `${item.taskId} (${item.error})`).join("; ")}`);
		this.name = "DispatchFailed";
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
 * agent. Returns the new Intent ids in the order the tasks were given. If some tasks cannot be
 * started, the rest still are, and DispatchFailed says which. `landFirst` names tasks whose
 * Intents must land before the others in this call are gated (demo and A/B choreography).
 */
export async function dispatchTasks(env: Env, taskIds: readonly TaskId[], priorityOrder?: readonly TaskId[], store: RepoStore = getRepoStore(env), options: { landFirst?: readonly TaskId[] } = {}): Promise<IntentId[]> {
	const trunk = await currentTrunk(env);
	const tasks = await loadTasks(env, store);
	const unknown = taskIds.filter((id) => !tasks.some((task) => task.id === id));
	if (unknown.length > 0) {
		throw new UnknownTasks(unknown);
	}

	const failed: DispatchFailed["failed"] = [];
	const started = await mapLimit(taskIds, DISPATCH_CONCURRENCY, async (taskId) => {
		try {
			return await dispatchOne(taskId);
		} catch (error) {
			// One task failing to start must not stop the others, or leave the caller not knowing which did.
			failed.push({ taskId, error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	});
	const ids = started.filter((id) => id !== null);
	if (options.landFirst !== undefined && options.landFirst.length > 0) {
		// Choreography: the Intents for these tasks land before any of the others dispatched with them.
		const first = taskIds.flatMap((taskId, index) => (options.landFirst?.includes(taskId) && started[index] ? [started[index] as IntentId] : []));
		await landing(env).hold(first, ids.filter((id) => !first.includes(id)));
	}
	await publishMetrics(env);
	if (failed.length > 0) {
		throw new DispatchFailed(ids, failed);
	}
	return ids;

	async function dispatchOne(taskId: TaskId): Promise<IntentId> {
		const task = tasks.find((candidate) => candidate.id === taskId) as TaskDef;
		const id = newIntentId();
		const { head } = await store.fork(trunk, id);
		await publish(env, { t: "artifacts", type: "forked", repo: id, detail: { source: trunk } });
		// The acceptance checks are copied here and never written again: IntentDO has no method that changes them.
		const acceptance = Object.freeze(structuredClone(task.acceptance)) as Intent["acceptance"];
		await intentStub(env, id).init(newIntent({ id, kind: "agent", taskId: task.id, goal: task.goal, acceptance, baseCommit: head, repo: id }));
		release(await env.AGENT_WORKFLOW.create({ id: workflowInstanceId(id, 0), params: { intentId: id, mode: "fresh", priority: priorityFor(taskId, priorityOrder) } }));
		return id;
	}
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

/**
 * True for a copy of trunk that a reset made: "trunk-" plus the time it was made in base36, which is
 * eight characters until the year 2059. Nothing looser: a repo somebody imported by hand under a
 * name of their own ("trunk-v2") is not one of these, and is never removed.
 */
export function isTrunkCopy(name: string): boolean {
	return /^trunk-[0-9a-z]{8}$/.test(name);
}

/**
 * Which of `names` a reset may remove: copies a reset made, except the trunk now in use and the trunks
 * of the runs that are kept, whose landings are what a replay of them reads its changes from. Pure.
 */
export function staleTrunks(names: readonly string[], inUse: string, kept: readonly string[]): string[] {
	return names.filter((name) => isTrunkCopy(name) && name !== inUse && !kept.includes(name));
}

/**
 * Removes one kept run from the record of runs (the owner's doing, from the Results tab), and the
 * copy of trunk it was on when nothing else needs that: not the trunk in use, not the original, and
 * not the trunk of another kept run. null for a run that is not kept.
 */
export async function deleteRun(env: Env, id: number, store: RepoStore = getRepoStore(env)): Promise<{ id: number; trunkRemoved: string | null } | null> {
	const gone = await hub(env).deleteRun(id);
	if (gone === null) {
		return null;
	}
	const [stale] = gone.trunk === null ? [] : staleTrunks([gone.trunk], await currentTrunk(env), [...(await hub(env).keptTrunks()), env.TRUNK_REPO]);
	if (stale === undefined) {
		return { id, trunkRemoved: null };
	}
	// The run is gone from the record either way. A copy that could not be removed is only left over.
	const removed = await store.remove(stale).then(
		() => true,
		() => false,
	);
	return { id, trunkRemoved: removed ? stale : null };
}

/** True for a repo that belongs to an Intent: "i" plus 8 base36 characters, optionally "-r<n>" for a re-derive. */
export function isIntentRepo(name: string): boolean {
	return /^i[0-9a-z]{8}(-r\d+)?$/.test(name);
}

/**
 * Puts everything back to the start for another demo run: deletes every Intent fork, makes a
 * fresh copy of the demo repo as trunk under a new name, and clears the event log and the ledger.
 * `asked: false` is for a reset nobody requested and no run follows (see `EventHub.reset`).
 * `origin` says who is starting the run that follows, for the record of runs.
 */
export async function resetDemo(env: Env, options: { asked?: boolean; origin?: RunSummary["origin"] } = {}): Promise<ResetResult> {
	const asked = options.asked ?? true;
	const store = getRepoStore(env);
	// Said before anything else: until the hub's own reset below, the board still shows the run before,
	// at rest, and a run started by a visitor in that time would land on top of this one.
	if (asked) {
		await hub(env).resetBegun();
	}
	// The fresh trunk, from the moment it exists until the hub has been told to use it.
	let unadopted: string | undefined;
	try {
		const previousTrunk = await currentTrunk(env);
		// The trunks of the runs kept so far. One of them may drop off the list at this reset.
		const keptBefore = await hub(env).keptTrunks();
		const names = await store.list();

		const forks = names.filter(isIntentRepo);
		await mapLimit(forks, DELETE_CONCURRENCY, (name) => store.remove(name).catch(() => undefined));

		const trunk = `trunk-${Date.now().toString(36)}`;
		unadopted = trunk;
		if (env.REPO_STORE === "memory") {
			await store.ensureRepo(trunk);
			await store.commit(trunk, ZERO_SHA, DEMO_REPO_FILES, "acme-accounts: initial");
		} else {
			const status = await importRepo(env, trunk, env.DEMO_REPO_URL);
			if (status !== "ready") {
				throw new Error(`the fresh trunk "${trunk}" is ${status}, not ready; the old trunk is still in use`);
			}
			// A repo that was imported a moment ago can refuse its first forks ("internal error") when
			// several arrive together, which is exactly what the first dispatch after a reset does. So
			// make one fork here, on its own, and only call the trunk ready once that has worked.
			const probe = newIntentId();
			await store.fork(trunk, probe);
			await store.remove(probe).catch(() => undefined);
		}

		const shards = await hub(env).shards();
		await Promise.all(shards.map((shard) => ledgerShard(env, shard).clear()));
		await landing(env).clear();
		await hub(env).setTrunk(trunk);
		unadopted = undefined;
		await hub(env).reset(asked, options.origin ?? "owner", previousTrunk);
		// The trunk of a run that is kept stays, so that the run's changes can still be read. What goes is only
		// what this hub knows to be finished with: the trunk just replaced, if its run was not kept, and the
		// trunk of a run that has just dropped off the list. Nothing is swept up by name alone, since another
		// Worker can share the namespace. Whatever is trunk at this moment, and the original, are left alone.
		const stale = staleTrunks([...new Set([previousTrunk, ...keptBefore])], trunk, [...(await hub(env).keptTrunks()), env.TRUNK_REPO, await currentTrunk(env)]);
		await mapLimit(stale, DELETE_CONCURRENCY, (name) => store.remove(name).catch(() => undefined));
		await publishMetrics(env);
		return { trunk, head: await store.head(trunk), forksDeleted: forks.length, previousTrunk };
	} catch (error) {
		// A reset that stops half way leaves the old trunk in use. The copy it was making is not needed,
		// and nothing should go on waiting for a reset that is not coming.
		if (unadopted !== undefined) {
			await store.remove(unadopted).catch(() => undefined);
		}
		if (asked) {
			await hub(env).resetAbandoned().catch(() => undefined);
		}
		throw error;
	}
}

/**
 * Memory mode only (local dev and tests). Repos held in memory are gone whenever the Worker's code
 * is loaded again: a dev-server restart, or an edit to any Worker file. Durable Object storage is
 * not, so the hub can still name the trunk copy the last reset made, and its log can still show
 * Intents whose forks no longer exist. Reading trunk then fails ("repo not found").
 *
 * This notices that state and starts again from nothing, exactly as a reset does. Returns true
 * when it had to. With real Artifacts there is nothing to recover, and it does nothing.
 */
export async function recoverMemoryStore(env: Env): Promise<boolean> {
	if (env.REPO_STORE !== "memory") {
		return false;
	}
	const [trunk, names, registry] = await Promise.all([currentTrunk(env), getRepoStore(env).list(), hub(env).registry()]);
	const trunkGone = !names.includes(trunk);
	const forksGone = registry.length > 0 && !names.some(isIntentRepo);
	if (!trunkGone && !forksGone) {
		return false;
	}
	await resetDemo(env, { asked: false });
	return true;
}
