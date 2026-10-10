// Waking agent runs that are paused. A run notes what it is waiting for in the EventHub; whoever
// makes that thing happen calls one of these.
import { hub, waitTopic } from "../hub/publish";

type WakeEnv = Pick<Env, "HUB" | "AGENT_WORKFLOW">;

export const LEDGER_FREE = "ledger-free";
export const HUMAN_CHOICE = "human-choice";

async function send(env: WakeEnv, topic: string, type: string, payload: unknown): Promise<number> {
	const instances = await hub(env).takeWaiters(topic);
	let woken = 0;
	for (const id of instances) {
		try {
			const instance = await env.AGENT_WORKFLOW.get(id);
			await instance.sendEvent({ type, payload });
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
