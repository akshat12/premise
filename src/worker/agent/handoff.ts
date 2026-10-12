// What happens to an Intent after its agent has pushed: the post-push checker, then the gate.
import type { CommitSha, Intent } from "../../shared/types";
import { type CheckerDeps, runChecker, settleQuarantine } from "../gate/checker";
import { gateEnqueue } from "../gate/client";
import { currentMode } from "../hub/publish";
import { intentStub } from "../intent/client";
import { onCheckerWake } from "./wake";

type HandOffEnv = Parameters<typeof runChecker>[0] & Pick<Env, "LANDING">;

/** Unless told otherwise, an Intent that passes the checker goes to the real gate. Tests pass their own `deps`. */
export async function handOff(env: HandOffEnv, intent: Intent, _commit: CommitSha, deps: CheckerDeps = { enqueue: gateEnqueue(env) }): Promise<void> {
	if (intent.status === "queued") {
		// An earlier try got as far as `queued` and may not have reached the gate. Asking again is harmless: the gate keeps one entry per Intent.
		await deps.enqueue?.(intent, "rebase");
		return;
	}
	if (intent.status !== "submitted" && intent.status !== "checking" && intent.status !== "rederiving") {
		return; // the Intent moved on while the agent was pushing
	}
	if ((await currentMode(env)) !== "premise") {
		await straightToGate(env, intent, deps);
		return;
	}
	await runChecker(env, intent.id, deps);
}

/**
 * A comparison run (the A/B report's baseline or queue) has no post-push checker: nothing was claimed, so there is
 * nothing to check the push against. The push goes straight to the gate's queue.
 */
export async function straightToGate(env: HandOffEnv, intent: Intent, deps: CheckerDeps = { enqueue: gateEnqueue(env) }): Promise<void> {
	const api = intentStub(env, intent.id);
	if (intent.status === "submitted") {
		await api.act({ a: "check" });
	}
	await deps.enqueue?.(await api.act({ a: "queue" }), "rebase");
}

// When an Intent finishes, quarantined Intents that were waiting on it ask the ledger again.
onCheckerWake((env, intentId) => settleQuarantine(env as HandOffEnv, intentId, "retry", { enqueue: gateEnqueue(env as HandOffEnv) }));
