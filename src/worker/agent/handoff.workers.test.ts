// The steps after a push are retried by the Workflow when one throws. Each must carry on from where the
// earlier try stopped: an Intent must not be left between its push and the gate with nothing to move it on.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RepoStore } from "../ports/repo-store";
import { replay, scriptFor, seededStore, startIntent } from "../testing/agent";
import { handOff } from "./handoff";
import { type AgentDeps, runAgent, type Steps } from "./run";

/** Steps that behave as workflow.ts configures them: a step that throws is run again, up to two more times. */
function retryingSteps(): Steps & { runs: Record<string, number> } {
	const runs: Record<string, number> = {};
	return {
		runs,
		async do(name, fn) {
			for (let attempt = 0; ; attempt++) {
				runs[name] = (runs[name] ?? 0) + 1;
				try {
					const result = await fn();
					return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as never;
				} catch (error) {
					if (attempt >= 2) throw error;
				}
			}
		},
		async waitForEvent() {
			return null as never;
		},
	};
}

describe("the steps after a push, retried", () => {
	it("one failed read in the post-push checker does not strand the Intent in `checking`: the retry checks and queues it", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t09-currency-format");
		// The store the checker reads through fails once (a transient Artifacts error), then works.
		let failures = 1;
		const flaky = new Proxy(store, {
			get(target, property, receiver) {
				const value: unknown = Reflect.get(target, property, receiver);
				if (property !== "snapshot" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
				return async (...args: unknown[]) => {
					if (failures > 0) {
						failures--;
						throw new Error("ArtifactsError: An internal error occurred.");
					}
					return (value as (...inner: unknown[]) => unknown).apply(target, args);
				};
			},
		}) as RepoStore;
		const enqueued: string[] = [];
		const steps = retryingSteps();
		const deps: AgentDeps = {
			env,
			store,
			intent: started.api,
			llm: replay(scriptFor("t09-currency-format")),
			handOff: (intent, commit) => handOff(env, intent, commit, { store: flaky, enqueue: async (queued) => void enqueued.push(queued.id) }),
		};
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		const intent = await started.api.get();
		expect(outcome.result).toBe("submitted");
		expect(steps.runs["hand-off"]).toBe(2);
		expect(failures).toBe(0);
		expect(intent.status).toBe("queued");
		expect(enqueued).toEqual([started.id]);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("an Intent left `queued` by a try that never reached the gate is offered to the gate again", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t09-currency-format");
		for (const action of [{ a: "claim" }, { a: "granted" }] as const) {
			await started.api.act(action);
		}
		const commit = await store.commit(started.intent.repo, started.intent.baseCommit, { "src/x.ts": "export const x = 1;\n" }, "work");
		await started.api.act({ a: "submit", commit });
		await started.api.act({ a: "check" });
		const queued = await started.api.act({ a: "queue" });
		const enqueued: string[] = [];
		await handOff(env, queued, commit, { store, enqueue: async (intent) => void enqueued.push(intent.id) });
		expect(enqueued).toEqual([started.id]);
		// Anything further on is not this step's to touch.
		await started.api.act({ a: "gate" });
		await handOff(env, await started.api.get(), commit, { store, enqueue: async (intent) => void enqueued.push(intent.id) });
		expect(enqueued).toEqual([started.id]);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);
});
