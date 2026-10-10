// The gate's Durable Object. There is one instance (named "trunk"), so trunk has a single writer:
// queued Intents are taken a batch at a time and each is rebased, checked and landed in turn.
// The checking itself is gateOne() in gate.ts; this file is the queue around it.
import { DurableObject } from "cloudflare:workers";
import type { CommitSha, GateReport, Intent, IntentId, SymbolId, TaskDef } from "../../shared/types";
import { currentTrunk, publish, publishMetrics } from "../hub/publish";
import { intentStub } from "../intent/client";
import { IllegalTransition } from "../intent/machine";
import { getRepoStore } from "../ports";
import { type FileMap, isCommitSha, type RepoStore } from "../ports/repo-store";
import { runInIsolate } from "../runner";
import { analyze, surface, type SurfaceMap } from "../surface";
import type { LandingStatus, QueueEntry, QueuePath } from "./client";
import { describeFailure, type GateDeps, gateOne } from "./gate";
import { type Invalidate, invalidate } from "./invalidate";
import { pickBatch, taskPriority } from "./queue";

/** How many times the gate starts on an Intent before giving up on it. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const SNAPSHOTS_KEPT = 8;

/**
 * What the gate remembers between Intents so it does not repeat work. A commit's files never
 * change, and the files trunk has after one landing are the files the next Intent rebases onto,
 * so most Intents cost one compiler run instead of three.
 */
export interface GateCache {
	snapshots: Map<CommitSha, FileMap>;
	surfaces: WeakMap<FileMap, SurfaceMap>;
}

export function newGateCache(): GateCache {
	return { snapshots: new Map(), surfaces: new WeakMap() };
}

export function rememberSnapshot(cache: GateCache, commit: CommitSha, files: FileMap): void {
	cache.snapshots.delete(commit);
	cache.snapshots.set(commit, files);
	for (const oldest of cache.snapshots.keys()) {
		if (cache.snapshots.size <= SNAPSHOTS_KEPT) {
			break;
		}
		cache.snapshots.delete(oldest);
	}
}

/** The real gate dependencies: the repo store, the TypeScript compiler, and the isolate runner. */
export function gateDeps(env: Pick<Env, "LOADER">, store: RepoStore, trunk: string, cache: GateCache = newGateCache()): GateDeps {
	return {
		trunk,
		head: (repo) => store.head(repo),
		async snapshot(repo, ref) {
			const kept = cache.snapshots.get(ref);
			if (kept !== undefined) {
				return kept;
			}
			const files = await store.snapshot(repo, ref);
			if (isCommitSha(ref)) {
				rememberSnapshot(cache, ref, files);
			}
			return files;
		},
		commitTrunk: (expectedHead, changes, message) => store.commit(trunk, expectedHead, changes, message),
		typecheck(files) {
			// One compiler program gives both answers; keep the surface for the diff that follows a landing.
			const result = analyze(files);
			cache.surfaces.set(files, result.surface);
			return result.typecheck;
		},
		surface(files) {
			let map = cache.surfaces.get(files);
			if (map === undefined) {
				map = surface(files).map;
				cache.surfaces.set(files, map);
			}
			return { map };
		},
		run: (req) => runInIsolate(env, req),
	};
}

export interface LandDeps {
	gate: GateDeps;
	invalidate?: Invalidate;
	cache?: GateCache;
}

export type LandOutcome =
	| { kind: "landed"; commit: CommitSha; changedSymbols: SymbolId[]; report: GateReport }
	| { kind: "stale" | "failed"; report: GateReport; note: string }
	/** The Intent was not waiting for the gate (it went stale, failed, or does not exist), so nothing was done. */
	| { kind: "skipped"; status: Intent["status"] | null };

type LandEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER">;

/** Changes an Intent's status, unless something else has already moved it on. */
async function settle(api: ReturnType<typeof intentStub>, action: Parameters<ReturnType<typeof intentStub>["act"]>[0], note?: string): Promise<void> {
	try {
		await api.act(action, note);
	} catch (error) {
		if (!(error instanceof IllegalTransition)) {
			throw error;
		}
	}
}

/**
 * Takes one Intent through the gate and deals with the result: it lands, or goes stale (a text
 * conflict, which a re-derive can fix), or fails. Publishes `gate.result`, and `trunk.advanced`
 * when trunk moved.
 */
export async function landIntent(env: LandEnv, intentId: IntentId, path: QueuePath, deps: LandDeps): Promise<LandOutcome> {
	const api = intentStub(env, intentId);
	let intent = await api.get().catch(() => null);
	if (intent === null) {
		return { kind: "skipped", status: null };
	}
	if (path === "rebase" && intent.status === "queued") {
		intent = await api.act({ a: "gate" });
	}
	// `gating` without the step above means an earlier attempt was cut short: carry on from there.
	if (intent.status !== (path === "rebase" ? "gating" : "rederiving")) {
		return { kind: "skipped", status: intent.status };
	}

	const { report, changedSymbols, newTrunkFiles, conflicts, trunkBefore } = await gateOne(deps.gate, intent, path);
	await publish(env, { t: "gate.result", report });

	if (report.landedCommit !== null && newTrunkFiles !== undefined) {
		const commit = report.landedCommit;
		if (deps.cache !== undefined) {
			rememberSnapshot(deps.cache, commit, newTrunkFiles);
		}
		await settle(api, { a: "land", commit });
		// An Intent whose work was already on trunk lands without moving it, so there is nothing to announce.
		if (commit !== trunkBefore) {
			// Our own code is what pushed, so it reports the push; the platform's event is only relayed (see events/consumer.ts).
			await publish(env, { t: "artifacts", type: "pushed", repo: deps.gate.trunk ?? "trunk", detail: { commit, intent: intentId } });
			await publish(env, { t: "trunk.advanced", commit, byIntent: intentId, changedSymbols });
			await (deps.invalidate ?? invalidate)(env, { commit, byIntent: intentId, changedSymbols, newTrunkFiles });
		}
		await publishMetrics(env);
		return { kind: "landed", commit, changedSymbols, report };
	}

	const note = describeFailure(report, conflicts);
	// A text conflict on the plain rebase is not the end: the Intent is stale and can be re-derived.
	const kind = report.textConflict && path === "rebase" ? "stale" : "failed";
	await settle(api, { a: kind === "stale" ? "stale" : "fail" }, note);
	await publishMetrics(env);
	return { kind, report, note };
}

type QueueRow = { intent_id: string; path: string; priority: number; enqueued_at: number; attempts: number };

const toEntry = (row: QueueRow): QueueEntry => ({ intentId: row.intent_id, path: row.path === "rederive" ? "rederive" : "rebase", priority: row.priority, enqueuedAt: row.enqueued_at, attempts: row.attempts });

/**
 * The gate. Reach it through `landing()` in gate/client.ts.
 *
 * `enqueue` adds an Intent and sets an alarm for now; the alarm takes one batch through the gate
 * and sets itself again while Intents remain. An alarm survives the object being evicted, so a
 * queued Intent is never forgotten, and alarms never overlap, so two batches never run at once.
 */
export class Landing extends DurableObject<Env> {
	private busy = false;
	private cache = newGateCache();
	private taskOrder: { trunk: string; tasks: Pick<TaskDef, "id">[] } | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS queue(intent_id TEXT PRIMARY KEY, path TEXT NOT NULL, priority INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
		});
	}

	private rows(): QueueEntry[] {
		return this.ctx.storage.sql.exec<QueueRow>("SELECT intent_id, path, priority, enqueued_at, attempts FROM queue ORDER BY enqueued_at, intent_id").toArray().map(toEntry);
	}

	/** The task list from trunk, which decides the order Intents are gated in. Read once per trunk. */
	private async tasks(trunk: string, store: RepoStore): Promise<Pick<TaskDef, "id">[]> {
		if (this.taskOrder?.trunk !== trunk) {
			let tasks: Pick<TaskDef, "id">[] = [];
			try {
				tasks = JSON.parse((await store.readFile(trunk, "main", "premise/tasks.json")) ?? "[]") as TaskDef[];
			} catch {
				// No readable task list: every Intent gets the same priority and the queue is first in, first out.
			}
			this.taskOrder = { trunk, tasks };
		}
		return this.taskOrder.tasks;
	}

	async enqueue(intentId: IntentId, path: QueuePath = "rebase"): Promise<void> {
		const intent = await intentStub(this.env, intentId).get().catch(() => null);
		const tasks = await this.tasks(await currentTrunk(this.env), getRepoStore(this.env));
		const priority = taskPriority(tasks, intent?.taskId ?? "");
		// Asking again for an Intent that is already queued keeps its place and takes the newer path.
		this.ctx.storage.sql.exec(
			"INSERT INTO queue (intent_id, path, priority, enqueued_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(intent_id) DO UPDATE SET path = excluded.path, attempts = 0",
			intentId,
			path === "rederive" ? "rederive" : "rebase",
			priority,
			Date.now(),
		);
		await this.ctx.storage.setAlarm(Date.now());
	}

	async status(): Promise<LandingStatus> {
		return { queue: this.rows(), busy: this.busy };
	}

	/** Empties the queue. Used when the demo is reset. */
	async clear(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM queue");
		await this.ctx.storage.deleteAlarm();
		this.cache = newGateCache();
		this.taskOrder = undefined;
	}

	async alarm(): Promise<void> {
		this.busy = true;
		let retry = false;
		try {
			retry = await this.processBatch();
		} catch (error) {
			// Never let the alarm itself fail: the platform would re-run it on its own schedule.
			console.error("gate: batch failed", error);
			retry = true;
		} finally {
			this.busy = false;
		}
		if (this.rows().length > 0 && (await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + (retry ? RETRY_DELAY_MS : 0));
		}
	}

	/** Gates one batch, in order. Returns true if an Intent hit an error and is still queued for another try. */
	private async processBatch(): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const store = getRepoStore(this.env);
		const trunk = await currentTrunk(this.env);
		const deps: LandDeps = { gate: gateDeps(this.env, store, trunk, this.cache), cache: this.cache };
		let retry = false;

		for (const entry of pickBatch(this.rows())) {
			try {
				await landIntent(this.env, entry.intentId, entry.path, deps);
				sql.exec("DELETE FROM queue WHERE intent_id = ?", entry.intentId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`gate: could not check ${entry.intentId} (attempt ${entry.attempts + 1})`, message);
				if (entry.attempts + 1 < MAX_ATTEMPTS) {
					sql.exec("UPDATE queue SET attempts = attempts + 1 WHERE intent_id = ?", entry.intentId);
					retry = true;
					continue;
				}
				sql.exec("DELETE FROM queue WHERE intent_id = ?", entry.intentId);
				await settle(intentStub(this.env, entry.intentId), { a: "fail" }, `The gate could not check this Intent: ${message}`).catch(() => undefined);
				await publishMetrics(this.env).catch(() => undefined);
			}
		}
		return retry;
	}
}
