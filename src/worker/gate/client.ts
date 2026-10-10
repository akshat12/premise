// How the rest of the backend reaches the gate.
import type { CommitSha, IntentId, IntentStatus } from "../../shared/types";
import type { Enqueue } from "./checker";
import type { RunningEntry, StaleEntry } from "./rederive";

export type QueuePath = "rebase" | "rederive";

export interface QueueEntry {
	intentId: IntentId;
	path: QueuePath;
	/** Position of the Intent's task in the task list. Lower goes first. */
	priority: number;
	enqueuedAt: number;
	/** Times the gate started on this Intent and could not finish (a repo or network error). */
	attempts: number;
}

export interface LandingStatus {
	/** Intents waiting to be gated. */
	queue: QueueEntry[];
	busy: boolean;
	/** Stale Intents waiting for a re-derive slot. */
	stale: StaleEntry[];
	/** Intents whose agent is re-deriving right now. */
	rederiving: RunningEntry[];
}

/** The Landing Durable Object's RPC surface, declared by hand so callers do not depend on generated stub types. */
export interface LandingApi {
	enqueue(intentId: IntentId, path?: QueuePath): Promise<void>;
	noteStale(intentId: IntentId, rebaseFailedAt?: CommitSha | null): Promise<void>;
	rederiveFailed(intentId: IntentId, attempt: number, reason: string): Promise<void>;
	humanChoice(intentId: IntentId, choice: "Retry" | "Abandon"): Promise<IntentStatus | null>;
	status(): Promise<LandingStatus>;
	clear(): Promise<void>;
}

/** The one gate. Every landing on trunk goes through this object, so trunk has a single writer. */
export function landing(env: Pick<Env, "LANDING">): LandingApi {
	return env.LANDING.get(env.LANDING.idFromName("trunk")) as unknown as LandingApi;
}

/** Sends an Intent that passed the checker to the gate. */
export function gateEnqueue(env: Pick<Env, "LANDING">): Enqueue {
	return (intent, path) => landing(env).enqueue(intent.id, path);
}
