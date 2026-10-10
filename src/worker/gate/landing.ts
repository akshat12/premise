// The gate's Durable Object. There is one instance (named "trunk"), so trunk has a single writer.
// It holds two queues:
//   - Intents waiting to be gated, taken a batch at a time and landed in turn (land.ts);
//   - stale Intents waiting to be re-derived, a few at a time (rederive.ts).
// All the deciding is in those two files and in gate.ts; this file is storage, ordering and wiring.
import { DurableObject } from "cloudflare:workers";
import type { Assertion, CommitSha, IntentId, IntentStatus, Premise, TaskDef } from "../../shared/types";
import { workflowInstanceId } from "../agent/instance";
import { currentTrunk, publish, publishMetrics } from "../hub/publish";
import { intentStub } from "../intent/client";
import { getRepoStore } from "../ports";
import type { RepoStore } from "../ports/repo-store";
import type { LandingStatus, QueueEntry, QueuePath } from "./client";
import { gateDeps, landIntent, newGateCache, settle } from "./land";
import { pickBatch, taskPriority } from "./queue";
import type { Standing, StandingStore } from "./standing";
import { DEFAULT_MAX_CONCURRENT, finishRederive, MAX_FAILED_REDERIVES, type RaceDeps, RederiveScheduler, type RederiveStore, type StaleEntry, type Started, startRace } from "./rederive";

/** How many times the gate starts on an Intent, or tries to start its re-derive, before giving up on that attempt. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/** A re-derive whose agent has not come back in this long is counted as failed. */
export const RACE_TIMEOUT_MS = 20 * 60 * 1000;

type QueueRow = { intent_id: string; path: string; priority: number; enqueued_at: number; attempts: number };
type StaleRow = { intent_id: string; priority: number; since: number; rebase_failed_at: string | null; reason: string | null };
type RunningRow = { intent_id: string; attempt: number; started: number };

const toEntry = (row: QueueRow): QueueEntry => ({ intentId: row.intent_id, path: row.path === "rederive" ? "rederive" : "rebase", priority: row.priority, enqueuedAt: row.enqueued_at, attempts: row.attempts });

/**
 * The gate. Reach it through `landing()` in gate/client.ts.
 *
 * Every method that adds work sets an alarm for now; the alarm gates one batch, starts whatever
 * re-derives there is room for, and sets itself again while work remains. An alarm survives the
 * object being evicted, so nothing queued is forgotten, and alarms never overlap, so two batches
 * never run at once.
 */
export class Landing extends DurableObject<Env> {
	private busy = false;
	private cache = newGateCache();
	private taskOrder: { trunk: string; tasks: Pick<TaskDef, "id">[] } | undefined;
	/** Stale Intents whose race could not be started just now; they go back in the queue after the current pass. */
	private deferred: StaleEntry[] = [];
	/** How many times in a row starting each Intent's race has thrown. */
	private startErrors = new Map<IntentId, number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS queue(intent_id TEXT PRIMARY KEY, path TEXT NOT NULL, priority INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
			sql.exec("CREATE TABLE IF NOT EXISTS stale_queue(intent_id TEXT PRIMARY KEY, priority INTEGER NOT NULL, since INTEGER NOT NULL, rebase_failed_at TEXT)");
			sql.exec("CREATE TABLE IF NOT EXISTS running(intent_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL, started INTEGER NOT NULL)");
			// Re-derives of an Intent that have failed since it last landed or a person last said Retry.
			sql.exec("CREATE TABLE IF NOT EXISTS rederive_failures(intent_id TEXT PRIMARY KEY, failed INTEGER NOT NULL)");
			// What landed Intents left behind for the gate to keep true (see standing.ts). The tests themselves are on trunk.
			sql.exec("CREATE TABLE IF NOT EXISTS standing_tests(intent_id TEXT NOT NULL, file TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (intent_id, file, name))");
			sql.exec("CREATE TABLE IF NOT EXISTS standing_assertions(intent_id TEXT NOT NULL, assertion_id TEXT NOT NULL, symbol TEXT NOT NULL, assertion TEXT NOT NULL, PRIMARY KEY (intent_id, assertion_id))");
			// Added after the table first shipped.
			if (!sql.exec<{ name: string }>("PRAGMA table_info(stale_queue)").toArray().some((column) => column.name === "reason")) {
				sql.exec("ALTER TABLE stale_queue ADD COLUMN reason TEXT");
			}
		});
	}

	// ---- storage ----

	private rows(): QueueEntry[] {
		return this.ctx.storage.sql.exec<QueueRow>("SELECT intent_id, path, priority, enqueued_at, attempts FROM queue ORDER BY enqueued_at, intent_id").toArray().map(toEntry);
	}

	private get rederives(): RederiveStore {
		const sql = this.ctx.storage.sql;
		return {
			waiting: () =>
				sql
					.exec<StaleRow>("SELECT intent_id, priority, since, rebase_failed_at, reason FROM stale_queue ORDER BY since, intent_id")
					.toArray()
					.map((row) => ({ intentId: row.intent_id, priority: row.priority, since: row.since, rebaseFailedAt: row.rebase_failed_at, reason: row.reason })),
			running: () =>
				sql
					.exec<RunningRow>("SELECT intent_id, attempt, started FROM running ORDER BY started, intent_id")
					.toArray()
					.map((row) => ({ intentId: row.intent_id, attempt: row.attempt, started: row.started })),
			addWaiting: (entry) => void sql.exec("INSERT OR REPLACE INTO stale_queue (intent_id, priority, since, rebase_failed_at, reason) VALUES (?, ?, ?, ?, ?)", entry.intentId, entry.priority, entry.since, entry.rebaseFailedAt ?? null, entry.reason ?? null),
			removeWaiting: (intentId) => void sql.exec("DELETE FROM stale_queue WHERE intent_id = ?", intentId),
			addRunning: (entry) => void sql.exec("INSERT OR REPLACE INTO running (intent_id, attempt, started) VALUES (?, ?, ?)", entry.intentId, entry.attempt, entry.started),
			removeRunning: (intentId) => void sql.exec("DELETE FROM running WHERE intent_id = ?", intentId),
		};
	}

	private get standingChecks(): StandingStore {
		const sql = this.ctx.storage.sql;
		return {
			all: (): Standing[] => {
				const byIntent = new Map<IntentId, Standing>();
				const entry = (intentId: IntentId) => {
					let standing = byIntent.get(intentId);
					if (standing === undefined) {
						standing = { intentId, tests: [], assertions: [] };
						byIntent.set(intentId, standing);
					}
					return standing;
				};
				for (const row of sql.exec<{ intent_id: string; file: string; name: string }>("SELECT intent_id, file, name FROM standing_tests ORDER BY rowid")) {
					entry(row.intent_id).tests.push({ file: row.file, name: row.name });
				}
				for (const row of sql.exec<{ intent_id: string; symbol: string; assertion: string }>("SELECT intent_id, symbol, assertion FROM standing_assertions ORDER BY rowid")) {
					entry(row.intent_id).assertions.push({ symbol: row.symbol, assertion: JSON.parse(row.assertion) as Assertion });
				}
				return [...byIntent.values()];
			},
			add: (standing) => {
				for (const test of standing.tests) {
					sql.exec("INSERT OR IGNORE INTO standing_tests (intent_id, file, name) VALUES (?, ?, ?)", standing.intentId, test.file, test.name);
				}
				for (const item of standing.assertions) {
					sql.exec("INSERT OR REPLACE INTO standing_assertions (intent_id, assertion_id, symbol, assertion) VALUES (?, ?, ?, ?)", standing.intentId, item.assertion.id, item.symbol, JSON.stringify(item.assertion));
				}
			},
			retire: (intentId, assertionIds) => {
				for (const assertionId of assertionIds) {
					sql.exec("DELETE FROM standing_assertions WHERE intent_id = ? AND assertion_id = ?", intentId, assertionId);
				}
			},
		};
	}

	private failures(intentId: IntentId): number {
		return this.ctx.storage.sql.exec<{ failed: number }>("SELECT failed FROM rederive_failures WHERE intent_id = ?", intentId).toArray()[0]?.failed ?? 0;
	}

	private setFailures(intentId: IntentId, failed: number): void {
		this.ctx.storage.sql.exec("INSERT OR REPLACE INTO rederive_failures (intent_id, failed) VALUES (?, ?)", intentId, failed);
	}

	/** The task list from trunk, which decides the order Intents are gated and re-derived in. Read once per trunk. */
	private async tasks(trunk: string, store: RepoStore): Promise<Pick<TaskDef, "id">[]> {
		if (this.taskOrder?.trunk !== trunk) {
			let tasks: Pick<TaskDef, "id">[] = [];
			try {
				tasks = JSON.parse((await store.readFile(trunk, "main", "premise/tasks.json")) ?? "[]") as TaskDef[];
			} catch {
				// No readable task list: every Intent gets the same priority and the queues are first in, first out.
			}
			this.taskOrder = { trunk, tasks };
		}
		return this.taskOrder.tasks;
	}

	private async priorityOf(intentId: IntentId): Promise<number> {
		const intent = await intentStub(this.env, intentId).get().catch(() => null);
		const tasks = await this.tasks(await currentTrunk(this.env), getRepoStore(this.env));
		return taskPriority(tasks, intent?.taskId ?? "");
	}

	private wake(delayMs = 0): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + delayMs);
	}

	// ---- what other parts of the system call ----

	async enqueue(intentId: IntentId, path: QueuePath = "rebase"): Promise<void> {
		const priority = await this.priorityOf(intentId);
		// Asking again for an Intent that is already queued keeps its place and takes the newer path.
		this.ctx.storage.sql.exec(
			"INSERT INTO queue (intent_id, path, priority, enqueued_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(intent_id) DO UPDATE SET path = excluded.path, attempts = 0",
			intentId,
			path === "rederive" ? "rederive" : "rebase",
			priority,
			Date.now(),
		);
		await this.wake();
	}

	/** An Intent went stale: get it re-derived. Whoever made it stale calls this (invalidation, or the gate itself). */
	async noteStale(intentId: IntentId, rebaseFailedAt: CommitSha | null = null): Promise<void> {
		await this.queueStale(intentId, rebaseFailedAt);
		await this.wake();
	}

	/** The agent re-deriving an Intent could not finish. Counts as a failed attempt. */
	async rederiveFailed(intentId: IntentId, attempt: number, reason: string): Promise<void> {
		const running = this.scheduler().isRunning(intentId);
		if (running === undefined || running.attempt !== attempt) {
			return; // an old attempt reporting late
		}
		await this.endRederive(intentId, { landed: false, reason });
		await this.wake();
	}

	/** A person answered the "Retry / Abandon" card of an Intent whose re-derives kept failing. Returns its status afterwards. */
	async humanChoice(intentId: IntentId, choice: "Retry" | "Abandon"): Promise<IntentStatus | null> {
		const api = intentStub(this.env, intentId);
		if (choice === "Abandon") {
			const running = this.scheduler().isRunning(intentId);
			this.scheduler().drop(intentId);
			this.ctx.storage.sql.exec("DELETE FROM queue WHERE intent_id = ?", intentId);
			if (running !== undefined) {
				await this.stopAgent(intentId, running.attempt);
			}
			await settle(api, { a: "human", choice }, "Abandoned");
		} else if (await settle(api, { a: "human", choice }, "Trying once more")) {
			// One more attempt, then back to a person.
			this.setFailures(intentId, MAX_FAILED_REDERIVES - 1);
			this.scheduler().noteStale({ intentId, priority: await this.priorityOf(intentId), since: Date.now() });
		}
		await publishMetrics(this.env);
		await this.wake();
		return (await api.get().catch(() => null))?.status ?? null;
	}

	/** The checks landed Intents left behind. Agents read them so `run_checks` can run them before the gate does. */
	async standing(): Promise<Standing[]> {
		return this.standingChecks.all();
	}

	async status(): Promise<LandingStatus> {
		return { queue: this.rows(), busy: this.busy, stale: this.rederives.waiting(), rederiving: this.rederives.running() };
	}

	/** Empties both queues. Used when the demo is reset. */
	async clear(): Promise<void> {
		for (const table of ["queue", "stale_queue", "running", "rederive_failures", "standing_tests", "standing_assertions"]) {
			this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
		}
		await this.ctx.storage.deleteAlarm();
		this.cache = newGateCache();
		this.taskOrder = undefined;
		this.deferred = [];
		this.startErrors.clear();
	}

	// ---- the work ----

	async alarm(): Promise<void> {
		this.busy = true;
		let retry = false;
		try {
			const trunk = await currentTrunk(this.env);
			const store = getRepoStore(this.env);
			const deps: RaceDeps = {
				store,
				trunk,
				gate: gateDeps(this.env, store, trunk, this.cache),
				cache: this.cache,
				standing: this.standingChecks,
				startAgent: (intent, attempt, broken, reason) => this.startAgent(intent.id, attempt, broken, reason),
			};
			// A slot marked as taken with no attempt number is a race whose start was cut short
			// (alarms never overlap, so none can be starting now). Put it back in the queue.
			for (const orphan of this.rederives.running().filter((entry) => entry.attempt === 0)) {
				this.rederives.removeRunning(orphan.intentId);
				this.scheduler().noteStale({ intentId: orphan.intentId, priority: await this.priorityOf(orphan.intentId), since: orphan.started });
			}
			retry = await this.processBatch(deps);
			await this.sweep();
			await this.scheduler(deps).pump();
			retry = this.requeueDeferred() || retry;
		} catch (error) {
			// Never let the alarm itself fail: the platform would re-run it on its own schedule.
			console.error("gate: pass failed", error);
			retry = true;
		} finally {
			this.busy = false;
		}
		if ((await this.ctx.storage.getAlarm()) !== null) {
			return; // more work arrived while this pass ran
		}
		const running = this.rederives.running();
		if (this.rows().length > 0 || retry) {
			await this.wake(retry ? RETRY_DELAY_MS : 0);
		} else if (running.length > 0) {
			// Nothing to do until an agent comes back. Look again when the oldest one would be overdue.
			await this.ctx.storage.setAlarm(Math.min(...running.map((entry) => entry.started)) + RACE_TIMEOUT_MS + 1);
		}
	}

	private scheduler(deps?: RaceDeps): RederiveScheduler {
		const configured = Number(this.env.MAX_CONCURRENT_REDERIVES);
		return new RederiveScheduler(this.rederives, configured > 0 ? configured : DEFAULT_MAX_CONCURRENT, async (entry): Promise<Started> => {
			if (deps === undefined) {
				throw new Error("races are only started from the alarm");
			}
			return this.race(entry, deps);
		});
	}

	/** Gates one batch, in order. Returns true if an Intent hit an error and is still queued for another try. */
	private async processBatch(deps: RaceDeps): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		let retry = false;

		for (const entry of pickBatch(this.rows())) {
			const id = entry.intentId;
			try {
				const outcome = await landIntent(this.env, id, entry.path, deps);
				sql.exec("DELETE FROM queue WHERE intent_id = ?", id);
				if (entry.path === "rederive") {
					if (outcome.kind === "landed") {
						await this.endRederive(id, { landed: true });
					} else if (outcome.kind === "failed") {
						await this.endRederive(id, { landed: false, reason: outcome.note });
					} else if (outcome.kind === "skipped" && outcome.status !== "stale") {
						this.scheduler().finished(id); // abandoned, or gone: free its slot
					}
				} else if (outcome.kind === "stale") {
					// The gate has just shown that the plain rebase does not pass on this trunk.
					await this.queueStale(id, outcome.trunkAt, outcome.note);
				}
				if (outcome.kind === "landed") {
					for (const other of outcome.stale) {
						await this.queueStale(other);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`gate: could not check ${id} (attempt ${entry.attempts + 1})`, message);
				if (entry.attempts + 1 < MAX_ATTEMPTS) {
					sql.exec("UPDATE queue SET attempts = attempts + 1 WHERE intent_id = ?", id);
					retry = true;
					continue;
				}
				sql.exec("DELETE FROM queue WHERE intent_id = ?", id);
				const reason = `The gate could not check this Intent: ${message}`;
				if (entry.path === "rederive" && this.scheduler().isRunning(id) !== undefined) {
					await this.endRederive(id, { landed: false, reason }).catch(() => undefined);
				} else {
					await settle(intentStub(this.env, id), { a: "fail" }, reason).catch(() => undefined);
				}
				await publishMetrics(this.env).catch(() => undefined);
			}
		}
		return retry;
	}

	/** Adds a stale Intent to the re-derive queue. If it was mid re-derive, trunk has moved under that attempt, which is void. */
	private async queueStale(intentId: IntentId, rebaseFailedAt: CommitSha | null = null, reason: string | null = null): Promise<void> {
		const scheduler = this.scheduler();
		const running = scheduler.isRunning(intentId);
		if (running !== undefined) {
			scheduler.finished(intentId);
			await this.stopAgent(intentId, running.attempt);
			await publish(this.env, { t: "rederive.race", id: intentId, rebase: "fail", rederive: "fail" });
		}
		scheduler.noteStale({ intentId, priority: await this.priorityOf(intentId), since: Date.now(), rebaseFailedAt, reason });
	}

	/** Runs one race to the point where it has landed or an agent is at work. */
	private async race(entry: StaleEntry, deps: RaceDeps): Promise<Started> {
		const id = entry.intentId;
		try {
			const result = await startRace(this.env, entry, deps);
			this.startErrors.delete(id);
			if (result.kind === "landed") {
				this.setFailures(id, 0);
				for (const other of result.outcome.stale) {
					await this.queueStale(other);
				}
				return { kind: "done" };
			}
			return result.kind === "rederiving" ? { kind: "running", attempt: result.attempt } : { kind: "done" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errors = (this.startErrors.get(id) ?? 0) + 1;
			console.error(`gate: could not start the re-derive of ${id} (attempt ${errors})`, message);
			if (errors < MAX_ATTEMPTS) {
				// Put it back after this pass, so one stubborn Intent cannot spin the loop.
				this.startErrors.set(id, errors);
				this.deferred.push(entry);
			} else {
				this.startErrors.delete(id);
				await this.endRederive(id, { landed: false, reason: `The re-derive could not be started: ${message}` }).catch(() => undefined);
			}
			return { kind: "done" };
		}
	}

	private requeueDeferred(): boolean {
		const entries = this.deferred;
		this.deferred = [];
		for (const entry of entries) {
			this.scheduler().noteStale({ ...entry, since: Date.now() });
		}
		return entries.length > 0;
	}

	/** Closes a re-derive: frees its slot, then lands, requeues, or hands the Intent to a person. */
	private async endRederive(intentId: IntentId, result: { landed: true } | { landed: false; reason: string }): Promise<void> {
		this.scheduler().finished(intentId);
		const failedBefore = this.failures(intentId);
		const end = await finishRederive(this.env, intentId, result, failedBefore);
		if (end === "landed") {
			this.setFailures(intentId, 0);
			return;
		}
		this.setFailures(intentId, failedBefore + 1);
		if (end === "stale") {
			this.scheduler().noteStale({ intentId, priority: await this.priorityOf(intentId), since: Date.now(), reason: result.landed ? null : result.reason });
		}
	}

	/** Counts a re-derive whose agent never came back as failed. */
	private async sweep(): Promise<void> {
		const overdue = this.rederives.running().filter((entry) => entry.attempt > 0 && Date.now() - entry.started > RACE_TIMEOUT_MS);
		for (const entry of overdue) {
			await this.stopAgent(entry.intentId, entry.attempt);
			await this.endRederive(entry.intentId, { landed: false, reason: "the re-derive did not finish in time" });
		}
	}

	private async startAgent(intentId: IntentId, attempt: number, broken: Premise[], reason?: string): Promise<void> {
		await this.env.AGENT_WORKFLOW.create({ id: workflowInstanceId(intentId, attempt), params: { intentId, mode: "rederive", attempt, broken, ...(reason === undefined ? {} : { reason }) } });
	}

	private async stopAgent(intentId: IntentId, attempt: number): Promise<void> {
		try {
			const instance = await this.env.AGENT_WORKFLOW.get(workflowInstanceId(intentId, attempt));
			await instance.terminate();
		} catch {
			// It has already finished, or never started. Either way it will not write anything more:
			// a run stops by itself once the Intent has moved on to a later attempt.
		}
	}
}
