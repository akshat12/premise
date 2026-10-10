// Runs one mode of the A/B comparison and measures it. Each mode starts from a reset, so it has
// its own fresh copy of trunk, an empty ledger and an empty event log; the two modes are run one
// after the other. Both get the same tasks, the same scripted workload (same seed), and the same
// choreography (the `verifySession` change lands first).
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, TaskId } from "../../shared/types";
import { DispatchFailed, dispatchTasks, loadTasks, resetDemo } from "../dispatch";
import { landing } from "../gate/client";
import { currentTrunk, hub, type RunMode } from "../hub/publish";
import { getRepoStore } from "../ports";
import { typecheck } from "../surface";
import { runWorkload, type Spawn } from "../workload/run";
import type { ModeResult } from "./report";

/** The task whose change the others rely on. It lands first in both modes, so both see the same order. */
export const AB_LAND_FIRST: TaskId[] = ["t01-null-expired"];

export interface AbOptions {
	mode: RunMode;
	/** Scripted workload size. 0 for none. */
	n: number;
	seed: number;
}

export interface AbStart extends AbOptions {
	trunk: string;
	startedAt: number;
	agents: IntentId[];
	workload: IntentId[];
}

/** Resets, switches mode, dispatches every demo task and starts the workload. Returns at once. */
export async function startAbMode(env: Env, options: AbOptions, deps: { spawn?: Spawn } = {}): Promise<AbStart> {
	await resetDemo(env);
	await hub(env).setMode(options.mode);
	const startedAt = Date.now();
	const tasks = (await loadTasks(env)).map((task) => task.id);
	let agents: IntentId[];
	try {
		agents = await dispatchTasks(env, tasks, undefined, undefined, { landFirst: AB_LAND_FIRST });
	} catch (error) {
		if (!(error instanceof DispatchFailed)) {
			throw error;
		}
		agents = error.started;
	}
	const workload = options.n > 0 ? (await runWorkload(env, { n: options.n, seed: options.seed }, deps.spawn ? { spawn: deps.spawn } : {})).intents : [];
	return { ...options, trunk: await currentTrunk(env), startedAt, agents, workload };
}

const SETTLED = new Set(["landed", "failed", "escalated", "quarantined"]);

/** True when nothing is moving: the gate is idle and every Intent has landed, failed, or is waiting for a person. */
export async function isQuiet(env: Env): Promise<{ quiet: boolean; counts: Record<string, number> }> {
	const [status, registry] = await Promise.all([landing(env).status(), hub(env).registry()]);
	const counts: Record<string, number> = {};
	for (const row of registry) {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
	}
	const moving = registry.some((row) => !SETTLED.has(row.status));
	return { quiet: !moving && registry.length > 0 && status.queue.length === 0 && !status.busy && status.stale.length === 0 && status.rederiving.length === 0, counts };
}

async function allEvents(env: Env): Promise<PremiseEvent[]> {
	const events: PremiseEvent[] = [];
	for (let since = 0; ; ) {
		const page = await hub(env).since(since, 2000);
		events.push(...page);
		const last = page.at(-1);
		if (last === undefined || page.length < 2000) {
			return events;
		}
		since = last.seq;
	}
}

/** Measures the run that has just gone quiet. */
export async function collectAb(env: Env, options: AbOptions): Promise<ModeResult> {
	const [metrics, registry, events, tasks, trunk, red] = await Promise.all([hub(env).metrics(), hub(env).registry(), allEvents(env), loadTasks(env), currentTrunk(env), landing(env).redReferenceTests()]);
	const first = events.find((event) => event.t === "intent.created")?.ts ?? events[0]?.ts ?? 0;
	const last = events.filter((event) => event.t === "intent.status" || event.t === "trunk.advanced").at(-1)?.ts ?? first;
	const wallTimeMs = Math.max(0, last - first);

	const ends = { landed: 0, failed: 0, escalated: 0, other: 0 };
	for (const row of registry) {
		ends[row.status === "landed" || row.status === "failed" || row.status === "escalated" ? row.status : "other"]++;
	}
	const taskIds = new Set(tasks.map((task) => task.id));
	const dispatched = registry.filter((row) => row.kind === "agent" && taskIds.has(row.taskId));

	const races = { started: 0, rebaseWon: 0, rederiveWon: 0, failed: 0 };
	const rejected = { textConflicts: 0, typecheck: 0, checks: 0 };
	let claimsLost = 0;
	for (const event of events) {
		if (event.t === "rederive.race") {
			if (event.rebase === "pending" && event.rederive === "pending") {
				races.started++;
			} else if (event.winner === "rebase") {
				races.rebaseWon++;
			} else if (event.winner === "rederive") {
				races.rederiveWon++;
			} else if (event.rebase === "fail" && event.rederive === "fail") {
				races.failed++;
			}
		} else if (event.t === "gate.result" && !event.report.ok) {
			rejected[event.report.textConflict ? "textConflicts" : !event.report.typecheck.ok ? "typecheck" : "checks"]++;
		} else if (event.t === "intent.status" && event.status === "failed" && (event.note ?? "").startsWith("could not get ")) {
			claimsLost++;
		}
	}

	const finalTypecheckOk = typecheck(await getRepoStore(env).snapshot(trunk, "main")).ok;
	return {
		...metrics,
		mode: options.mode,
		n: options.n,
		seed: options.seed,
		trunk,
		wallTimeMs,
		landingsPerMinute: wallTimeMs === 0 ? 0 : metrics.intentsLanded / (wallTimeMs / 60_000),
		tasksLanded: dispatched.filter((row) => row.status === "landed").length,
		tasksDispatched: dispatched.length,
		ends,
		races,
		falsePositiveRate: races.started === 0 ? 0 : races.rebaseWon / races.started,
		rejected,
		claimsLost,
		redReferenceTests: red,
		finalTypecheckOk,
	};
}

/** Starts a mode, waits for it to go quiet, and measures it. For tests and for small runs made in one request. */
export async function runAbMode(env: Env, options: AbOptions, deps: { spawn?: Spawn; timeoutMs?: number; pollMs?: number } = {}): Promise<ModeResult> {
	await startAbMode(env, options, deps);
	const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? 500));
		if ((await isQuiet(env)).quiet) {
			return collectAb(env, options);
		}
		if (Date.now() > deadline) {
			throw new Error(`the ${options.mode} run did not go quiet in time: ${JSON.stringify((await isQuiet(env)).counts)}`);
		}
	}
}
