// The gate's Durable Object. There is one instance (named "trunk"), so trunk has a single writer.
// It holds two queues:
//   - Intents waiting to be gated, taken a batch at a time and landed in turn (land.ts);
//   - stale Intents waiting to be re-derived, a few at a time (rederive.ts).
// All the deciding is in those two files and in gate.ts; this file is storage, ordering and wiring.
import { DurableObject } from "cloudflare:workers";
import type { Assertion, CommitSha, IntentId, IntentKind, IntentStatus, Premise, TaskDef } from "../../shared/types";
import { workflowInstanceId } from "../agent/instance";
import { hiddenTests, newlyRed, redTests } from "../ab/regress";
import { currentMode, currentTrunk, hub, publish, publishMetrics } from "../hub/publish";
import { intentStub } from "../intent/client";
import { getRepoStore } from "../ports";
import type { RepoStore } from "../ports/repo-store";
import type { LandingStatus, QueueEntry, QueuePath } from "./client";
import { gateDeps, landBatch, landIntent, newGateCache, settle } from "./land";
import { BATCH_SIZE, pickBatch, taskPriority, WORKLOAD_BATCH_SIZE } from "./queue";
import type { Standing, StandingStore } from "./standing";
import { DEFAULT_MAX_CONCURRENT, finishRederive, MAX_FAILED_REDERIVES, type RaceDeps, RederiveScheduler, type RederiveStore, type StaleEntry, type Started, startRace } from "./rederive";

/**
 * Bump this when the gate's behaviour changes. `GET /api/gate` reports it, which is the only way
 * to tell that this object is running the new code after a deploy: a busy Durable Object can go
 * on running the previous version for minutes.
 */
export const GATE_VERSION = 6;
/** How many times the gate starts on an Intent, or tries to start its re-derive, before giving up on that attempt. */
export const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
/** Statuses in which an Intent that others are held behind is still expected to reach the gate and land. */
const ON_ITS_WAY: readonly IntentStatus[] = ["planning", "claiming", "waiting", "working", "submitted", "checking", "quarantined", "queued", "gating"];
const HOLD_POLL_MS = 1_000;
/** A re-derive whose agent has not come back in this long is counted as failed. */
export const RACE_TIMEOUT_MS = 20 * 60 * 1000;

type QueueRow = { intent_id: string; path: string; priority: number; enqueued_at: number; attempts: number; kind: string | null };
type StaleRow = { intent_id: string; priority: number; since: number; rebase_failed_at: string | null; reason: string | null };
type RunningRow = { intent_id: string; attempt: number; started: number };

const toEntry = (row: QueueRow): QueueEntry => ({ intentId: row.intent_id, path: row.path === "rederive" ? "rederive" : "rebase", priority: row.priority, enqueuedAt: row.enqueued_at, attempts: row.attempts, kind: row.kind === "workload" ? "workload" : "agent" });

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
	private taskOrder: { trunk: string; tasks: TaskDef[] } | undefined;
	/** Stale Intents whose race could not be started just now; they go back in the queue after the current pass. */
	private deferred: StaleEntry[] = [];
	/** True when the last pass found nothing it was allowed to gate, only Intents being held back. */
	private onlyHeldLeft = false;
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
			if (!sql.exec<{ name: string }>("PRAGMA table_info(queue)").toArray().some((column) => column.name === "kind")) {
				sql.exec("ALTER TABLE queue ADD COLUMN kind TEXT");
			}
			// Demo choreography: `intent_id` is not gated until `waits_for` has landed or stopped (see hold()).
			sql.exec("CREATE TABLE IF NOT EXISTS holds(intent_id TEXT NOT NULL, waits_for TEXT NOT NULL, PRIMARY KEY (intent_id, waits_for))");
			// For counting regressions that reach trunk: the demo tasks that have landed, and their reference tests that were red after the last landing.
			sql.exec("CREATE TABLE IF NOT EXISTS landed_tasks(task_id TEXT PRIMARY KEY)");
			sql.exec("CREATE TABLE IF NOT EXISTS red_tests(key TEXT PRIMARY KEY)");
		});
	}

	// ---- storage ----

	private rows(): QueueEntry[] {
		return this.ctx.storage.sql.exec<QueueRow>("SELECT intent_id, path, priority, enqueued_at, attempts, kind FROM queue ORDER BY enqueued_at, intent_id").toArray().map(toEntry);
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
	private async tasks(trunk: string, store: RepoStore): Promise<TaskDef[]> {
		if (this.taskOrder?.trunk !== trunk) {
			let tasks: TaskDef[] = [];
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
		return (await this.describe(intentId)).priority;
	}

	private async describe(intentId: IntentId): Promise<{ priority: number; kind: IntentKind }> {
		const intent = await intentStub(this.env, intentId).get().catch(() => null);
		const tasks = await this.tasks(await currentTrunk(this.env), getRepoStore(this.env));
		return { priority: taskPriority(tasks, intent?.taskId ?? ""), kind: intent?.kind ?? "agent" };
	}

	private wake(delayMs = 0): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + delayMs);
	}

	// ---- what other parts of the system call ----

	async enqueue(intentId: IntentId, path: QueuePath = "rebase"): Promise<void> {
		const { priority, kind } = await this.describe(intentId);
		// Asking again for an Intent that is already queued keeps its place and takes the newer path.
		this.ctx.storage.sql.exec(
			"INSERT INTO queue (intent_id, path, priority, enqueued_at, attempts, kind) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(intent_id) DO UPDATE SET path = excluded.path, attempts = 0",
			intentId,
			path === "rederive" ? "rederive" : "rebase",
			priority,
			Date.now(),
			kind,
		);
		await this.wake();
	}

	/**
	 * Choreography for a demo or an A/B run: none of `rest` is gated until every one of `first` has
	 * landed or stopped being on its way. It only orders landings; it changes nothing about what
	 * the gate checks. Without it, which of several Intents dispatched together lands first depends
	 * on which agent happens to finish first.
	 */
	async hold(first: IntentId[], rest: IntentId[]): Promise<void> {
		for (const waiting of rest) {
			for (const ahead of first) {
				if (waiting !== ahead) {
					this.ctx.storage.sql.exec("INSERT OR IGNORE INTO holds (intent_id, waits_for) VALUES (?, ?)", waiting, ahead);
				}
			}
		}
	}

	/** Intents that must not be gated yet. Holds on Intents that have landed or stopped are dropped first. */
	private async held(): Promise<Set<IntentId>> {
		const sql = this.ctx.storage.sql;
		const ahead = sql.exec<{ waits_for: string }>("SELECT DISTINCT waits_for FROM holds").toArray().map((row) => row.waits_for);
		for (const id of ahead) {
			const status = (await intentStub(this.env, id).get().catch(() => null))?.status;
			if (status === undefined || !ON_ITS_WAY.includes(status)) {
				sql.exec("DELETE FROM holds WHERE waits_for = ?", id);
			}
		}
		return new Set(sql.exec<{ intent_id: string }>("SELECT DISTINCT intent_id FROM holds").toArray().map((row) => row.intent_id));
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
		return { queue: this.rows(), busy: this.busy, stale: this.rederives.waiting(), rederiving: this.rederives.running(), version: GATE_VERSION };
	}

	/** Empties both queues. Used when the demo is reset. */
	async clear(): Promise<void> {
		for (const table of ["queue", "stale_queue", "running", "rederive_failures", "standing_tests", "standing_assertions", "holds", "landed_tasks", "red_tests"]) {
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
				baseline: (await currentMode(this.env)) === "baseline",
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
			// If everything left is being held back, look again in a moment rather than at once.
			await this.wake(retry ? RETRY_DELAY_MS : this.onlyHeldLeft ? HOLD_POLL_MS : 0);
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

	/**
	 * Gates the next Intents in the queue, in order. An agent's Intent gets a gate run to itself;
	 * scripted workload Intents land several to a commit. Returns true if something hit an error
	 * and is still queued for another try.
	 */
	private async processBatch(deps: RaceDeps): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const held = await this.held();
		const rows = this.rows();
		const next = pickBatch(rows.filter((entry) => !held.has(entry.intentId)), WORKLOAD_BATCH_SIZE);
		this.onlyHeldLeft = next.length === 0 && rows.length > 0;
		const together = next.filter((entry) => entry.kind === "workload" && entry.attempts === 0);
		const batched = new Set(together.length > 1 ? together.map((entry) => entry.intentId) : []);
		const alone = next.filter((entry) => !batched.has(entry.intentId));
		let retry = false;

		for (const entry of alone.slice(0, BATCH_SIZE)) {
			retry = (await this.gateSingle(entry, deps)) || retry;
		}
		// The batch waits its turn: if there were more single Intents ahead of it than one pass takes, it goes next pass.
		if (batched.size === 0 || alone.length > BATCH_SIZE) {
			return retry;
		}
		let singly: IntentId[];
		try {
			const outcome = await landBatch(this.env, together.map((entry) => entry.intentId), deps);
			if (outcome.commit !== null && outcome.landed.length > 0) {
				await this.afterLanding(outcome.commit, outcome.landed, deps);
			}
			for (const entry of together) {
				// Whatever is not held back, or left for a run of its own, is done with: it landed, or was no longer waiting.
				if (!outcome.singly.includes(entry.intentId) && !outcome.deferred.includes(entry.intentId)) {
					sql.exec("DELETE FROM queue WHERE intent_id = ?", entry.intentId);
				}
			}
			for (const other of outcome.stale) {
				await this.queueStale(other);
			}
			singly = outcome.singly;
		} catch (error) {
			// The batch as a whole could not be checked. Each member gets its own run, with its own retries.
			console.error("gate: batch could not be checked", error instanceof Error ? error.message : String(error));
			singly = together.map((entry) => entry.intentId);
		}
		for (const entry of together.filter((candidate) => singly.includes(candidate.intentId))) {
			retry = (await this.gateSingle(entry, deps)) || retry;
		}
		return retry;
	}

	/** One Intent through the gate, and what follows from the result. Returns true if it hit an error and stays queued. */
	private async gateSingle(entry: QueueEntry, deps: RaceDeps): Promise<boolean> {
		const sql = this.ctx.storage.sql;
		const id = entry.intentId;
		try {
			const outcome = await landIntent(this.env, id, entry.path, deps);
			sql.exec("DELETE FROM queue WHERE intent_id = ?", id);
			if (entry.path === "rederive" && entry.kind === "workload") {
				// A stale workload Intent having its rebase tried again. There is no agent behind it, so this is its only chance.
				if (outcome.kind === "landed") {
					await publish(this.env, { t: "rederive.race", id, rebase: "pass", rederive: "pending", winner: "rebase" });
				} else if (outcome.kind === "failed") {
					await publish(this.env, { t: "rederive.race", id, rebase: "fail", rederive: "fail" });
					await settle(intentStub(this.env, id), { a: "fail" }, outcome.note);
					await publishMetrics(this.env);
				}
			} else if (entry.path === "rederive") {
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
				await this.afterLanding(outcome.commit, [id], deps);
			}
			return false;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`gate: could not check ${id} (attempt ${entry.attempts + 1})`, message);
			if (entry.attempts + 1 < MAX_ATTEMPTS) {
				sql.exec("UPDATE queue SET attempts = attempts + 1 WHERE intent_id = ?", id);
				return true;
			}
			sql.exec("DELETE FROM queue WHERE intent_id = ?", id);
			const reason = `The gate could not check this Intent: ${message}`;
			if (entry.path === "rederive" && this.scheduler().isRunning(id) !== undefined) {
				await this.endRederive(id, { landed: false, reason }).catch(() => undefined);
			} else {
				await settle(intentStub(this.env, id), { a: "fail" }, reason).catch(() => undefined);
			}
			await publishMetrics(this.env).catch(() => undefined);
			return false;
		}
	}

	/**
	 * After every landing: do the reference tests of the demo tasks that have landed still pass on
	 * trunk? One that is newly red is a behavioural regression that reached trunk, and is counted.
	 * This is measurement only; it never stops or undoes anything (in the A/B comparison it is what
	 * shows the difference between the two landing rules).
	 */
	private async afterLanding(commit: CommitSha, landed: readonly IntentId[], deps: RaceDeps): Promise<void> {
		try {
			const sql = this.ctx.storage.sql;
			const tasks = await this.tasks(deps.trunk, deps.store);
			for (const id of landed) {
				const taskId = (await intentStub(this.env, id).get().catch(() => null))?.taskId;
				if (taskId !== undefined && tasks.some((task) => task.id === taskId)) {
					sql.exec("INSERT OR IGNORE INTO landed_tasks (task_id) VALUES (?)", taskId);
				}
			}
			const files = this.cache.snapshots.get(commit);
			const done = sql.exec<{ task_id: string }>("SELECT task_id FROM landed_tasks").toArray().map((row) => row.task_id);
			const tests = files === undefined ? [] : hiddenTests(tasks, done, files);
			if (files === undefined || tests.length === 0) {
				return;
			}
			const red = redTests(tests, await deps.gate.run({ files, tests, assertions: [] }));
			const fresh = newlyRed(sql.exec<{ key: string }>("SELECT key FROM red_tests").toArray().map((row) => row.key), red);
			sql.exec("DELETE FROM red_tests");
			for (const key of red) {
				sql.exec("INSERT OR IGNORE INTO red_tests (key) VALUES (?)", key);
			}
			if (fresh.length > 0) {
				await hub(this.env).bump("behaviouralRegressionsOnTrunk", fresh.length);
				await publishMetrics(this.env);
			}
		} catch (error) {
			console.error("gate: could not run the reference tests after a landing", error instanceof Error ? error.message : String(error));
		}
	}

	/** Reference tests of landed demo tasks that are red on trunk right now. */
	async redReferenceTests(): Promise<string[]> {
		return this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM red_tests ORDER BY key").toArray().map((row) => row.key);
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
			if (result.kind === "regate") {
				this.ctx.storage.sql.exec(
					"INSERT INTO queue (intent_id, path, priority, enqueued_at, attempts, kind) VALUES (?, 'rederive', ?, ?, 0, 'workload') ON CONFLICT(intent_id) DO UPDATE SET path = 'rederive', attempts = 0, kind = 'workload'",
					id,
					entry.priority,
					Date.now(),
				);
				return { kind: "done" };
			}
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
