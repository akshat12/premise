// Re-derive instead of rebase. When an Intent goes stale, two attempts are made to get its goal
// onto the new trunk, and whichever passes the Intent's unchanged acceptance checks lands:
//   - the rebase: the work it already pushed, rebased textually onto the new trunk;
//   - the re-derive: a fresh fork of the new trunk, and the Intent's agent run again from the
//     stored goal, told what broke.
// The rebase is checked first because it takes about a second and costs nothing; the agent is
// only started once the rebase is known not to pass. In the demo the rebase fails on behaviour,
// and the re-derive wins honestly.
import type { CommitSha, Intent, IntentId, Premise } from "../../shared/types";
import { publish, publishMetrics } from "../hub/publish";
import { intentStub } from "../intent/client";
import type { RepoStore } from "../ports/repo-store";
import { type LandDeps, type LandEnv, type LandOutcome, landWork, settle } from "./land";

/** After this many failed re-derives in a row, a person is asked. */
export const MAX_FAILED_REDERIVES = 2;
export const DEFAULT_MAX_CONCURRENT = 3;

export interface StaleEntry {
	intentId: IntentId;
	/** Position of the Intent's task in the task list. Lower goes first. */
	priority: number;
	since: number;
	/** The trunk commit the gate has just rebased this Intent's work onto and rejected, if it has. */
	rebaseFailedAt?: CommitSha | null;
	/** Why it did not land, in one line, when the gate rejected it. The re-deriving agent is told. */
	reason?: string | null;
}

export interface RunningEntry {
	intentId: IntentId;
	attempt: number;
	started: number;
}

/** Where the scheduler keeps its two lists. The Landing object backs this with SQLite; tests use memory. */
export interface RederiveStore {
	waiting(): StaleEntry[];
	running(): RunningEntry[];
	addWaiting(entry: StaleEntry): void;
	removeWaiting(intentId: IntentId): void;
	addRunning(entry: RunningEntry): void;
	removeRunning(intentId: IntentId): void;
}

export class MemoryRederiveStore implements RederiveStore {
	private waitingList: StaleEntry[] = [];
	private runningList: RunningEntry[] = [];
	waiting = () => [...this.waitingList];
	running = () => [...this.runningList];
	addWaiting(entry: StaleEntry): void {
		this.waitingList.push(entry);
	}
	removeWaiting(intentId: IntentId): void {
		this.waitingList = this.waitingList.filter((entry) => entry.intentId !== intentId);
	}
	addRunning(entry: RunningEntry): void {
		this.runningList.push(entry);
	}
	removeRunning(intentId: IntentId): void {
		this.runningList = this.runningList.filter((entry) => entry.intentId !== intentId);
	}
}

/**
 * What `start` reports. "running" means an agent is now at work and holds one of the slots until
 * `finished` is called. "done" means the race is already over (the rebase landed, or there was
 * nothing to do), so the slot is free again at once.
 */
export type Started = { kind: "running"; attempt: number } | { kind: "done" };

/**
 * Decides which stale Intents are re-derived now and which wait. At most `cap` agents run at
 * once; the rest queue by priority, then by how long they have waited. Without the cap, a busy
 * trunk would keep every Intent re-deriving against a trunk that moves again before it lands.
 */
export class RederiveScheduler {
	constructor(
		private readonly store: RederiveStore,
		private readonly cap: number,
		private readonly start: (entry: StaleEntry) => Promise<Started>,
		private readonly now: () => number = Date.now,
	) {}

	/** Queues a stale Intent. Returns false if it is already waiting or running. */
	noteStale(entry: StaleEntry): boolean {
		if (this.store.waiting().some((item) => item.intentId === entry.intentId) || this.store.running().some((item) => item.intentId === entry.intentId)) {
			return false;
		}
		this.store.addWaiting(entry);
		return true;
	}

	/** The Intents that would start next, best first. */
	next(): StaleEntry[] {
		const free = Math.max(0, this.cap - this.store.running().length);
		return [...this.store.waiting()].sort((a, b) => a.priority - b.priority || a.since - b.since || (a.intentId < b.intentId ? -1 : 1)).slice(0, free);
	}

	/** Starts as many waiting Intents as there are free slots. Returns the ids it started. */
	async pump(): Promise<IntentId[]> {
		const started: IntentId[] = [];
		for (let entry = this.next()[0]; entry !== undefined; entry = this.next()[0]) {
			this.store.removeWaiting(entry.intentId);
			// The slot is taken before `start` runs, so nothing else can take it meanwhile.
			this.store.addRunning({ intentId: entry.intentId, attempt: 0, started: this.now() });
			let result: Started;
			try {
				result = await this.start(entry);
			} catch (error) {
				this.store.removeRunning(entry.intentId);
				throw error;
			}
			this.store.removeRunning(entry.intentId);
			if (result.kind === "running") {
				this.store.addRunning({ intentId: entry.intentId, attempt: result.attempt, started: this.now() });
			}
			started.push(entry.intentId);
		}
		return started;
	}

	/** A running re-derive ended, one way or the other. Frees its slot. */
	finished(intentId: IntentId): void {
		this.store.removeRunning(intentId);
	}

	/** Forgets an Intent entirely (it was abandoned, or the demo was reset). */
	drop(intentId: IntentId): void {
		this.store.removeWaiting(intentId);
		this.store.removeRunning(intentId);
	}

	isRunning(intentId: IntentId): RunningEntry | undefined {
		return this.store.running().find((entry) => entry.intentId === intentId);
	}
}

export interface RaceDeps extends LandDeps {
	store: RepoStore;
	trunk: string;
	/** Starts the Intent's agent on its fresh fork. `broken` is what the agent is told no longer holds; `reason` is why its work did not land. */
	startAgent(intent: Intent, attempt: number, broken: Premise[], reason?: string): Promise<void>;
}

export type RaceStart =
	/** The Intent was not stale any more. */
	| { kind: "skipped"; status: Intent["status"] | null }
	/** The rebase passed, so it landed. */
	| { kind: "landed"; outcome: Extract<LandOutcome, { kind: "landed" }> }
	/** The rebase did not pass; the agent is re-deriving on `fork`. */
	| { kind: "rederiving"; attempt: number; fork: string }
	/** A scripted workload Intent whose rebase did not pass. It has no agent to re-derive it, so it is failed. */
	| { kind: "failed"; reason: string }
	/** A scripted workload Intent whose rebase is worth trying: send it back through the gate, where it can land in a batch. */
	| { kind: "regate" };

/** The fork a re-derive attempt works in. */
export const rederiveFork = (intentId: IntentId, attempt: number) => `${intentId}-r${attempt}`;

/**
 * Starts the race for one stale Intent: try the rebase, and if that does not land, fork the
 * current trunk and start the agent on it.
 */
export async function startRace(env: LandEnv, entry: StaleEntry, deps: RaceDeps): Promise<RaceStart> {
	const id = entry.intentId;
	const api = intentStub(env, id);
	let intent = await api.get().catch(() => null);
	if (intent === null) {
		return { kind: "skipped", status: null };
	}
	const trunkHead = await deps.gate.head(deps.trunk);
	const rebaseIsPointless = intent.headCommit === null || entry.rebaseFailedAt === trunkHead;
	if (intent.kind === "workload" && rebaseIsPointless) {
		// Nothing to try: there is no agent behind a workload Intent, and its rebase is already known not to pass.
		const reason = entry.reason ?? "its work no longer fits trunk";
		await settle(api, { a: "fail" }, reason);
		await publishMetrics(env);
		return { kind: "failed", reason };
	}
	if (intent.status === "stale") {
		intent = await api.act({ a: "rederive" });
	} else if (intent.status !== "rederiving") {
		// `rederiving` without the step above: a person chose Retry, which moves it there directly.
		return { kind: "skipped", status: intent.status };
	}
	// The work as it stands, before the Intent is pointed at a new fork.
	const before = intent;
	const attempt = (await api.incRederive()).rederiveAttempts;
	await publish(env, { t: "rederive.race", id, rebase: "pending", rederive: "pending" });
	if (before.kind === "workload") {
		// Its only path is the rebase, and the gate can do that for many of them at once.
		return { kind: "regate" };
	}

	// The rebase. Skipped when there is nothing pushed to rebase, or when the gate has just
	// rejected exactly this rebase onto exactly this trunk.
	let reason = entry.reason ?? undefined;
	if (!rebaseIsPointless) {
		const outcome = await landWork(env, before, "rebase", deps);
		if (outcome.kind === "landed") {
			await publish(env, { t: "rederive.race", id, rebase: "pass", rederive: "pending", winner: "rebase" });
			await publishMetrics(env);
			return { kind: "landed", outcome };
		}
		reason = outcome.note;
	}
	await publish(env, { t: "rederive.race", id, rebase: "fail", rederive: "pending" });

	// The re-derive: a fresh fork of trunk as it is now, and the agent again from the stored goal.
	const fork = rederiveFork(id, attempt);
	const { head } = await deps.store.fork(deps.trunk, fork);
	await publish(env, { t: "artifacts", type: "forked", repo: fork, detail: { source: deps.trunk, intent: id } });
	const restarted = await api.restartOn(fork, head);
	await deps.startAgent(restarted, attempt, before.premises.filter((premise) => premise.state === "broken"), reason);
	await publishMetrics(env);
	return { kind: "rederiving", attempt, fork };
}

export type RederiveEnd = "landed" | "stale" | "escalated";

/**
 * Closes a race whose rebase had failed, now that the re-derive has an answer. `failedBefore` is
 * how many re-derives of this Intent had already failed. A landed re-derive wins. A failed one
 * sends the Intent round again, or to a person once it has failed MAX_FAILED_REDERIVES times.
 */
export async function finishRederive(env: LandEnv, intentId: IntentId, result: { landed: true } | { landed: false; reason: string }, failedBefore: number): Promise<RederiveEnd> {
	if (result.landed) {
		await publish(env, { t: "rederive.race", id: intentId, rebase: "fail", rederive: "pass", winner: "rederive" });
		await publishMetrics(env);
		return "landed";
	}
	await publish(env, { t: "rederive.race", id: intentId, rebase: "fail", rederive: "fail" });
	const api = intentStub(env, intentId);
	const failed = failedBefore + 1;
	if (failed < MAX_FAILED_REDERIVES) {
		await settle(api, { a: "stale" }, `Re-derive did not land: ${result.reason}`);
		await publishMetrics(env);
		return "stale";
	}
	if (await settle(api, { a: "escalate" }, `Re-derived ${failed} times without landing`)) {
		await publish(env, {
			t: "human.needed",
			id: intentId,
			kind: "fallback",
			message: `This Intent was re-derived ${failed} times and still does not pass its acceptance checks on trunk. Last reason: ${result.reason}`,
			options: ["Retry", "Abandon"],
		});
	}
	await publishMetrics(env);
	return "escalated";
}
