// A redo whose agent finished but whose work never reached the gate's queue. Seen once on the
// deployed Worker (Oct 13): the agent's Workflow completed after pushing and checking its work,
// and the gate went on waiting for it until its 20-minute timeout. Whatever lost the hand-off,
// the gate can see the state it leaves behind, and picks the work up itself. Pure.
import type { Intent } from "../../shared/types";
import type { RunningEntry } from "./rederive";

/** A redo is only looked at once it has been running this long: a normal one hands its work over well before. */
export const LOST_AFTER_MS = 60_000;
/** While redos are running, the gate looks for lost ones this often. */
export const LOST_CHECK_MS = 30_000;

/** The parts of a Workflow instance's status this needs. */
export type WorkflowState = "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "rollingBack" | "unknown";

/**
 * True when the redo in `entry` is finished and pushed but not in the gate's queue: the Intent is
 * still on this very attempt, it has a push from this attempt's fork, the agent's Workflow has
 * completed (so its own hand-off is over, one way or the other), and nothing of it is queued.
 * `workflow` is null when it could not be read, which never counts as finished.
 */
export function isLostRedo(
	entry: RunningEntry,
	intent: Pick<Intent, "id" | "status" | "rederiveAttempts" | "headCommit" | "repo"> | null,
	queued: boolean,
	workflow: WorkflowState | null,
	now: number,
): boolean {
	return (
		entry.attempt > 0 &&
		now - entry.started >= LOST_AFTER_MS &&
		!queued &&
		intent !== null &&
		intent.status === "rederiving" &&
		intent.rederiveAttempts === entry.attempt &&
		intent.headCommit !== null &&
		intent.repo === `${intent.id}-r${entry.attempt}` &&
		workflow === "complete"
	);
}

/** When the gate should next wake while redos are running: in time to find a lost one, and at the latest when the oldest would time out. */
export function nextLook(running: readonly RunningEntry[], now: number, timeoutMs: number): number | null {
	if (running.length === 0) {
		return null;
	}
	const timeout = Math.min(...running.map((entry) => entry.started)) + timeoutMs + 1;
	return running.some((entry) => entry.attempt > 0) ? Math.min(timeout, now + LOST_CHECK_MS) : timeout;
}
