// What happens to an Intent after its agent has pushed. Later tasks grow this: T13 adds the
// post-push checker, T15 the gate queue, T17 the re-derive path.
import type { CommitSha, Intent } from "../../shared/types";
import { intentStub } from "../intent/client";

export async function handOff(env: Pick<Env, "INTENT">, intent: Intent, _commit: CommitSha): Promise<void> {
	if (intent.status !== "submitted") {
		return; // a re-derive, or an Intent that moved on while the agent was pushing
	}
	const api = intentStub(env, intent.id);
	await api.act({ a: "check" });
	await api.act({ a: "queue" });
}
