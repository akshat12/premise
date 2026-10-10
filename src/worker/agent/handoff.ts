// What happens to an Intent after its agent has pushed: the post-push checker, then the gate.
import type { CommitSha, Intent } from "../../shared/types";
import { type CheckerDeps, runChecker, settleQuarantine } from "../gate/checker";
import { onCheckerWake } from "./wake";

type HandOffEnv = Parameters<typeof runChecker>[0];

export async function handOff(env: HandOffEnv, intent: Intent, _commit: CommitSha, deps: CheckerDeps = {}): Promise<void> {
	if (intent.status !== "submitted" && intent.status !== "rederiving") {
		return; // the Intent moved on while the agent was pushing
	}
	await runChecker(env, intent.id, deps);
}

// When an Intent finishes, quarantined Intents that were waiting on it ask the ledger again.
onCheckerWake((env, intentId) => settleQuarantine(env as HandOffEnv, intentId, "retry"));
