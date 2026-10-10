import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newIntentId } from "../../shared/ids";
import type { Assertion } from "../../shared/types";
import { gateDeps, landIntent } from "../gate/land";
import { OUTSIDE_PUSH } from "../gate/invalidate";
import { currentTrunk, hub } from "../hub/publish";
import { intentStub, newIntent } from "../intent/client";
import { MemoryRepoStore } from "../ports/memory-repo-store";
import { demoTask } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { consumeBatch, handleArtifactsEvent } from "./consumer";

const VERIFY = "src/auth/session.ts#verifySession";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;

const pushed = (repoName: string, before: string, after: string, message: string) => ({
	type: "cf.artifacts.repo.pushed",
	source: { type: "artifacts.repo", namespace: "premise", repoName },
	payload: { ref: "refs/heads/main", before, after, commits: [{ id: after, message, parents: [before] }], totalCommitsCount: 1, commitsTruncated: false },
	metadata: { eventSchemaVersion: 1 },
});

/** A private repo store whose trunk has the name the Worker currently calls trunk. */
async function world() {
	const trunk = await currentTrunk(env);
	const store = new MemoryRepoStore({ [trunk]: demoFiles() });
	async function intent(taskId: string) {
		const id = newIntentId();
		const { head } = await store.fork(trunk, id);
		const task = demoTask(taskId);
		const api = intentStub(env, id);
		const record = await api.init(newIntent({ id, kind: "agent", taskId, goal: task.goal, acceptance: structuredClone(task.acceptance), baseCommit: head }));
		await api.act({ a: "claim" });
		await api.act({ a: "granted" });
		return { id, api, record };
	}
	return { trunk, store, intent };
}

const lastSeq = async () => (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;

describe("handleArtifactsEvent", () => {
	it("relays a platform fork event without counting the fork again", async () => {
		const before = await hub(env).metrics();
		const seq = await lastSeq();
		const result = await handleArtifactsEvent(env, {
			type: "cf.artifacts.repo.forked",
			source: { type: "artifacts", namespace: "premise", repoName: "trunk" },
			payload: { namespace: "premise", repoName: "i3k9x0a2q", repoId: "5ankv1vhl4xnw7wq", defaultBranch: "main" },
			metadata: { eventSchemaVersion: 1 },
		});
		expect(result).toEqual({ published: 1, invalidated: false });
		expect(await hub(env).since(seq)).toMatchObject([{ t: "artifacts", type: "repo.forked", repo: "i3k9x0a2q", detail: { source: "trunk" } }]);
		expect((await hub(env).metrics()).forksCreated).toBe(before.forksCreated);
	});

	it("a push to trunk from outside the gate breaks the premises it invalidates", async () => {
		const { trunk, store, intent } = await world();
		const relying = await intent("t02-audit-expired");
		await relying.api.recordPremise({ symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS });

		// Someone with a token pushes the verifySession change straight to trunk.
		const before = await store.head(trunk);
		const after = await store.commit(trunk, before, referencePatch("t01"), "Return null for expired sessions");
		const event = pushed(trunk, before, after, "Return null for expired sessions");
		const seq = await lastSeq();

		expect(await handleArtifactsEvent(env, event, { store })).toEqual({ published: 1, invalidated: true });
		const stale = await relying.api.get();
		expect(stale.status).toBe("stale");
		const reason = `assertion '${SESSION_THROWS.description}' no longer holds after a push to trunk`;
		expect(stale.premises[0]).toMatchObject({ state: "broken", brokenBy: { intentId: OUTSIDE_PUSH, commit: after, reason } });
		const events = await hub(env).since(seq);
		expect(events[0]).toMatchObject({ t: "artifacts", type: "repo.pushed", repo: trunk, detail: { before, after, intent: null } });
		// (Other test files share this event log and may have Intents in flight, so look for this one's.)
		expect(events.filter((item) => item.t === "premise.broken" && item.id === relying.id)).toMatchObject([{ symbol: VERIFY, byIntent: OUTSIDE_PUSH, commit: after, reason }]);

		// The queue may deliver the same message again. The second time it is relayed and nothing else happens.
		const brokenSoFar = (await hub(env).metrics()).premisesBroken;
		expect(await handleArtifactsEvent(env, event, { store })).toEqual({ published: 1, invalidated: false });
		expect((await hub(env).metrics()).premisesBroken).toBe(brokenSoFar);
		await relying.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("does not repeat the work for a push the gate itself made", async () => {
		const { trunk, store, intent } = await world();
		const lander = await intent("t09-currency-format");
		const commit = await store.commit(lander.id, lander.record.baseCommit, referencePatch("t09"), "work");
		await lander.api.act({ a: "submit", commit });
		await lander.api.act({ a: "check" });
		await lander.api.act({ a: "queue" });
		const before = await store.head(trunk);
		const outcome = await landIntent(env, lander.id, "rebase", { gate: gateDeps(env, store, trunk) });
		expect(outcome.kind).toBe("landed");
		const after = await store.head(trunk);

		const seq = await lastSeq();
		const event = pushed(trunk, before, after, `intent ${lander.id}: Format yen\n\nPremise-Intent: ${lander.id}`);
		expect(await handleArtifactsEvent(env, event, { store, invalidate: async () => Promise.reject(new Error("must not be called")) })).toEqual({ published: 1, invalidated: false });
		expect(await hub(env).since(seq)).toMatchObject([{ t: "artifacts", type: "repo.pushed", repo: trunk, detail: { after, intent: lander.id } }]);
	}, 30_000);

	it("ignores pushes to other repos and the first push to an empty trunk", async () => {
		const { trunk, store } = await world();
		const head = await store.head(trunk);
		const refuse = { store, invalidate: async () => Promise.reject(new Error("must not be called")) };
		expect(await handleArtifactsEvent(env, pushed("isomefork1", "a".repeat(40), "b".repeat(40), "work"), refuse)).toEqual({ published: 1, invalidated: false });
		expect(await handleArtifactsEvent(env, pushed(trunk, "0".repeat(40), head, "initial"), refuse)).toEqual({ published: 1, invalidated: false });
		expect(await handleArtifactsEvent(env, { type: "cf.artifacts.repo.cloned", source: { repoName: trunk } }, refuse)).toEqual({ published: 0, invalidated: false });
	});
});

describe("consumeBatch", () => {
	it("acknowledges every message, including one it cannot handle", async () => {
		const acked: string[] = [];
		const message = (id: string, body: unknown) => ({ id, body, timestamp: new Date(), attempts: 1, ack: () => void acked.push(id), retry: () => undefined });
		const trunk = await currentTrunk(env);
		const batch = {
			queue: "premise-events",
			messages: [
				message("m1", { type: "cf.artifacts.repo.created", source: { type: "artifacts", namespace: "premise", repoName: "inewrepo01" }, payload: {} }),
				// A trunk push whose commits do not exist: reading them fails.
				message("m2", pushed(trunk, "e".repeat(40), "f".repeat(40), "who knows")),
				message("m3", "not an event at all"),
			],
			ackAll: () => undefined,
			retryAll: () => undefined,
		} as unknown as MessageBatch<unknown>;
		const seq = await lastSeq();
		await consumeBatch(batch, env);
		expect(acked).toEqual(["m1", "m2", "m3"]);
		expect((await hub(env).since(seq)).map((event) => event.t === "artifacts" && event.type)).toEqual(["repo.created", "repo.pushed"]);
	});
});
