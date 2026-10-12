// A landing is watched for regressions whichever way it reached trunk: through the queue, or as the
// plain rebase a stale Intent is given first. (The second used to go unmeasured.)
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newIntentId } from "../../shared/ids";
import type { Intent } from "../../shared/types";
import { resetDemo } from "../dispatch";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { getRepoStore } from "../ports";
import type { FileChanges } from "../ports/repo-store";
import { demoTask } from "../testing/agent";
import { referencePatch } from "../testing/demo";
import { landing } from "./client";

async function queuedOnTrunk(taskId: string, changes: FileChanges): Promise<{ id: string; api: IntentApi }> {
	const store = getRepoStore(env);
	const trunk = await currentTrunk(env);
	const task = demoTask(taskId);
	const id = newIntentId();
	const { head } = await store.fork(trunk, id);
	const api = intentStub(env, id);
	await api.init(newIntent({ id, kind: "agent", taskId, goal: task.goal, acceptance: structuredClone(task.acceptance), baseCommit: head }));
	await api.act({ a: "claim" });
	await api.act({ a: "granted" });
	const commit = await store.commit(id, head, changes, "work");
	await api.act({ a: "submit", commit });
	await api.act({ a: "check" });
	await api.act({ a: "queue" });
	return { id, api };
}
async function waitFor(api: IntentApi, wanted: Intent["status"][], timeoutMs: number): Promise<Intent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const intent = await api.get();
		if (wanted.includes(intent.status) || Date.now() > deadline) return intent;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
async function gateIdle(timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await landing(env).status();
		if ((status.queue.length === 0 && !status.busy && status.stale.length === 0 && status.rederiving.length === 0) || Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** t01 lands; then the old-logic t11 (its probe is red on that trunk) lands, by `how`. Returns what the gate measured. */
async function run(how: "queue" | "race-rebase") {
	await gateIdle();
	await resetDemo(env);
	const t01 = await queuedOnTrunk("t01-null-expired", referencePatch("t01"));
	await landing(env).enqueue(t01.id);
	expect((await waitFor(t01.api, ["landed", "failed", "escalated"], 30_000)).status).toBe("landed");
	await gateIdle();
	const t11 = await queuedOnTrunk("t11-expired-rate-limit", referencePatch("t11"));
	if (how === "queue") {
		await landing(env).enqueue(t11.id);
	} else {
		await t11.api.act({ a: "stale" }, "a premise broke");
		await landing(env).noteStale(t11.id);
	}
	const landed = await waitFor(t11.api, ["landed", "failed", "escalated"], 30_000);
	await gateIdle();
	const events = await hub(env).since(0, 5000);
	const races = events.flatMap((event) => (event.t === "rederive.race" && event.id === t11.id ? [`${event.rebase}/${event.rederive}/${event.winner ?? "-"}`] : []));
	return { how, status: landed.status, races, red: await landing(env).redReferenceTests(), regressions: (await hub(env).metrics()).behaviouralRegressionsOnTrunk };
}

describe("regressions are measured after a landing", () => {
	it("whether it came through the queue or through a stale Intent's rebase", async () => {
		const viaQueue = await run("queue");
		const viaRace = await run("race-rebase");
		expect(viaQueue.status).toBe("landed");
		expect(viaRace.status).toBe("landed");
		expect(viaRace.races.at(-1)).toBe("pass/pending/rebase");
		// Old-logic t11 on a trunk where verifySession returns null: its end-to-end probe is red either way.
		expect(viaQueue.regressions).toBe(1);
		expect(viaRace.regressions).toBe(1);
		expect(viaRace.red).toEqual(viaQueue.red);
		expect(viaRace.red.length).toBeGreaterThan(0);
	}, 120_000);
});
