// Waking agent runs that are paused. A run notes what it is waiting for in the EventHub; whoever
// makes that thing happen calls one of these.
import { hub, waitTopic } from "../hub/publish";
import { release } from "../ports/release";

type WakeEnv = Pick<Env, "HUB" | "AGENT_WORKFLOW">;

/**
 * Waiters are normally Workflow instance ids. One whose id starts with this prefix is a
 * quarantined Intent waiting for the checker to look again; `recheck` handles those.
 */
export const CHECKER_WAITER = "checker:";
let recheck: ((env: WakeEnv, intentId: string) => Promise<unknown>) | undefined;

/** Registers what to do for a quarantined Intent when the Intent it waits on finishes. Set by the checker's wiring. */
export function onCheckerWake(handler: (env: WakeEnv, intentId: string) => Promise<unknown>): void {
	recheck = handler;
}

export const LEDGER_FREE = "ledger-free";
export const HUMAN_CHOICE = "human-choice";

async function send(env: WakeEnv, topic: string, type: string, payload: unknown): Promise<number> {
	const instances = await hub(env).takeWaiters(topic);
	let woken = 0;
	for (const id of instances) {
		try {
			if (id.startsWith(CHECKER_WAITER)) {
				await recheck?.(env, id.slice(CHECKER_WAITER.length));
				woken++;
				continue;
			}
			const instance = await env.AGENT_WORKFLOW.get(id);
			try {
				await instance.sendEvent({ type, payload });
			} finally {
				release(instance);
			}
			woken++;
		} catch {
			// The instance has finished or been terminated. Nothing to wake.
		}
	}
	return woken;
}

/** An Intent landed or failed, so its claims are free: wake the runs that were waiting on it. */
export function wakeLedgerWaiters(env: WakeEnv, intentId: string): Promise<number> {
	return send(env, waitTopic.ledger(intentId), LEDGER_FREE, { freedBy: intentId });
}

/** A person chose what happens to an Intent: wake its run with the choice. */
export function wakeHumanWaiters(env: WakeEnv, intentId: string, choice: string): Promise<number> {
	return send(env, waitTopic.human(intentId), HUMAN_CHOICE, { choice });
}
