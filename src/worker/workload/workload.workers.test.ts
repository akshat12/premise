import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Intent } from "../../shared/types";
import { resetDemo } from "../dispatch";
import { landing } from "../gate/client";
import { currentTrunk, hub } from "../hub/publish";
import { intentStub } from "../intent/client";
import type { RegistryRow } from "../metrics";
import { getRepoStore } from "../ports";
import { typecheck } from "../surface";
import { TokenBucket } from "./bucket";
import { CALLS_PER_INTENT, planWorkload, runWorkload, runWorkloadIntent, spawnInProcess, spawnWorkflows, WORKLOAD_TASK, type WorkloadParams } from "./run";

const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };

async function gateIdle(timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await landing(env).status();
		if ((status.queue.length === 0 && !status.busy && status.stale.length === 0 && status.rederiving.length === 0) || Date.now() > deadline) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const statusOf = async (id: string) => (await intentStub(env, id).get()).status;

// The workload lands on the Worker's own trunk, so each group starts from a fresh one.
beforeAll(async () => {
	await gateIdle(30_000);
	await resetDemo(env);
});

describe("a workload of 40 scripted Intents, in memory", () => {
	it("every one ends landed or failed, nothing hangs, nobody is asked, and the numbers agree", async () => {
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const headBefore = await store.head(trunk);

		const summary = await runWorkload(env, { n: 40, seed: 7, overlapRate: 0.15 }, { spawn: spawnInProcess(env, store, { concurrency: 25, backoffMs: 20 }) });
		expect(summary).toMatchObject({ n: 40, seed: 7, trunk, started: 40 });
		expect(summary.intents).toHaveLength(40);
		expect(summary.kinds.helper + summary.kinds.body + summary.kinds.field).toBe(40);
		expect(summary.kinds.helper).toBeGreaterThan(10);
		// Each one's own part ended at the gate's queue, or in failure. None is still claiming or working.
		expect(summary.results?.every((result) => ["queued", "gating", "landed", "stale", "rederiving", "failed"].includes(result.status))).toBe(true);

		await gateIdle(150_000);
		const ends = await Promise.all(summary.intents.map(statusOf));
		const count = (status: Intent["status"]) => ends.filter((end) => end === status).length;
		expect(ends.every((end) => end === "landed" || end === "failed")).toBe(true);
		expect(count("landed")).toBeGreaterThanOrEqual(30);
		expect(count("landed") + count("failed")).toBe(40);

		// They are labelled as what they are, everywhere.
		const registry = (await hub(env).registry()).filter((row: RegistryRow) => summary.intents.includes(row.id));
		expect(registry).toHaveLength(40);
		expect(registry.every((row) => row.kind === "workload" && row.taskId === WORKLOAD_TASK)).toBe(true);
		const sample = await intentStub(env, summary.intents[0] ?? "").get();
		expect(sample).toMatchObject({ kind: "workload", acceptance: [] });
		expect(sample.goal).toMatch(/^w7_0: /);

		// Trunk moved, still typechecks, and has the generated helpers that landed.
		expect(await store.head(trunk)).not.toBe(headBefore);
		const files = await store.snapshot(trunk, "main");
		expect(typecheck(files).errors).toEqual([]);
		expect(Object.keys(files).filter((path) => path.startsWith("src/generated/w7_")).length).toBeGreaterThan(8);

		// The counters the UI shows agree with what happened.
		const metrics = await hub(env).metrics();
		expect(metrics.intentsLanded).toBe(count("landed"));
		expect(metrics.agentsActive).toBe(0);
		expect(metrics.forksCreated).toBeGreaterThanOrEqual(40);
		// Pushes are each Intent's push to its own fork plus the gate's pushes to trunk. A trunk push
		// may carry several workload Intents, and between them they carry every Intent that landed.
		const pushes = (await hub(env).since(0, 5000)).flatMap((event) => (event.t === "artifacts" && event.type === "pushed" ? [event] : []));
		const trunkPushes = pushes.filter((event) => event.repo === trunk).map((event) => event.detail ?? {});
		expect(metrics.pushes).toBe(pushes.length);
		expect(pushes.length - trunkPushes.length).toBeGreaterThanOrEqual(count("landed"));
		expect(trunkPushes.reduce((sum, detail) => sum + (typeof detail.batch === "number" ? detail.batch : 1), 0)).toBe(count("landed"));
		expect(metrics.humanMerges).toBe(0);
		expect(metrics.brokenBuildsOnTrunk).toBe(0);

		// Why the failures failed: lost a claim to another workload Intent, or no longer fitted trunk. Never a crash.
		const events = await hub(env).since(0, 5000);
		const failures = events.flatMap((event) => (event.t === "intent.status" && event.status === "failed" ? [event.note ?? ""] : []));
		expect(failures).toHaveLength(count("failed"));
		for (const note of failures) {
			expect(note).toMatch(/^could not get .* still holds it after 3 retries$|^Text conflict with trunk|^Typecheck failed on the new trunk|no longer there|no longer fits trunk/);
		}
		expect(events.some((event) => event.t === "human.needed")).toBe(false);
		// A type-surface change by one workload Intent invalidates the others that read it; when that happened, the plain rebase settled it.
		const raceWinners = events.flatMap((event) => (event.t === "rederive.race" && event.winner !== undefined ? [event.winner] : []));
		expect(raceWinners.every((winner) => winner === "rebase")).toBe(true);
	}, 240_000);
});

describe("workload Intents waiting at the gate together", () => {
	it("land several to a commit, each with its own verdict, and the push says it is a batch", async () => {
		await gateIdle(30_000);
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		// Twelve Intents, each taken as far as the gate's door and held there.
		const held: string[] = [];
		const summary = await runWorkload(env, { n: 12, seed: 55, overlapRate: 0 }, { spawn: spawnInProcess(env, store, { concurrency: 12, enqueue: async (intent) => void held.push(intent.id) }) });
		expect(held).toHaveLength(12);
		const seq = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;
		// Now they all arrive within a moment of each other.
		await Promise.all(held.map((id) => landing(env).enqueue(id)));
		await gateIdle(60_000);

		const ends = await Promise.all(summary.intents.map(statusOf));
		const landed = summary.intents.filter((_, index) => ends[index] === "landed");
		expect(ends.every((end) => end === "landed" || end === "failed")).toBe(true);
		expect(landed.length).toBeGreaterThanOrEqual(10);

		const events = await hub(env).since(seq, 5000);
		const pushes = events.flatMap((event) => (event.t === "artifacts" && event.type === "pushed" && event.repo === trunk ? [event.detail ?? {}] : []));
		const advances = events.filter((event) => event.t === "trunk.advanced");
		// Far fewer commits than Intents, and at least one commit carrying many.
		expect(pushes.length).toBeLessThanOrEqual(6);
		expect(advances).toHaveLength(pushes.length);
		expect(Math.max(...pushes.map((detail) => (typeof detail.batch === "number" ? detail.batch : 1)))).toBeGreaterThanOrEqual(5);
		expect(pushes.flatMap((detail) => (Array.isArray(detail.intents) ? (detail.intents as string[]) : [String(detail.intent)])).sort()).toEqual([...landed].sort());
		// Every Intent still has its own verdict and its own status change.
		const verdicts = events.flatMap((event) => (event.t === "gate.result" && event.report.ok ? [event.report.intentId] : []));
		expect(verdicts.sort()).toEqual([...landed].sort());
		expect(events.filter((event) => event.t === "intent.status" && event.status === "landed")).toHaveLength(landed.length);
		// And trunk, after all of it, still typechecks.
		expect(typecheck(await store.snapshot(trunk, "main")).errors).toEqual([]);
	}, 120_000);
});

describe("starting the workload as Workflow instances", () => {
	it("creates one instance per job, in batches paced by the Artifacts budget", async () => {
		const plan = await planWorkload(env, getRepoStore(env), { n: 30, seed: 3 });
		const batches: { id: string; params: WorkloadParams }[][] = [];
		const taken: number[] = [];
		const bucket = { take: async (cost: number) => void taken.push(cost) } as unknown as TokenBucket;
		const fakeEnv = { AGENT_WORKFLOW: { createBatch: async (options: { instances: { id: string; params: WorkloadParams }[] }) => void batches.push(options.instances) } } as unknown as Pick<Env, "AGENT_WORKFLOW">;

		expect(await spawnWorkflows(fakeEnv, { bucket })(plan)).toEqual({ started: 30 });
		// 150 calls a second at 12 calls an Intent is 12 Intents a batch.
		expect(batches.map((batch) => batch.length)).toEqual([12, 12, 6]);
		expect(taken).toEqual([12 * CALLS_PER_INTENT, 12 * CALLS_PER_INTENT, 6 * CALLS_PER_INTENT]);
		const all = batches.flat();
		expect(all.map((instance) => instance.id)).toEqual(plan.jobs.map((job) => `${job.intentId}-0`));
		expect(all[0]?.params).toEqual({ mode: "workload", job: plan.jobs[0], trunk: plan.trunk });
		// A job is plain data: it survives being sent to another process.
		expect(JSON.parse(JSON.stringify(plan.jobs))).toEqual(plan.jobs);
	});

	it("three Intents started through the real Workflow reach trunk", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const summary = await runWorkload(env, { n: 3, seed: 21, overlapRate: 0 });
		expect(summary).toMatchObject({ started: 3 });
		expect(summary.results).toBeUndefined();
		const instances = await introspector.get();
		expect(instances).toHaveLength(3);
		await Promise.all(instances.map((instance) => instance.waitForStatus("complete")));
		await gateIdle(60_000);
		expect(await Promise.all(summary.intents.map(statusOf))).toEqual(["landed", "landed", "landed"]);
	}, 120_000);
});

describe("POST /api/admin/workload", () => {
	it("needs the admin token and a sensible n", async () => {
		const call = (body: unknown, headers: Record<string, string> = ADMIN) => exports.default.fetch("http://premise.test/api/admin/workload", { method: "POST", headers, body: JSON.stringify(body) });
		const noToken = await call({ n: 3 }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();
		for (const body of [{}, { n: 0 }, { n: 1.5 }, { n: 5000 }, { n: "many" }]) {
			const response = await call(body);
			expect(response.status).toBe(400);
			await response.text();
		}
	});
});

describe("a workload Intent that goes stale", () => {
	it("goes back through the gate when its rebase is worth trying, and lands there", async () => {
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const plan = await planWorkload(env, store, { n: 6, seed: 123, overlapRate: 0 });
		const held: string[] = [];
		for (const job of plan.jobs) {
			await runWorkloadIntent(env, store, job, { trunk, enqueue: async (intent) => void held.push(intent.id) });
		}
		expect(held.length).toBeGreaterThanOrEqual(5);
		const seq = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;
		// Something they relied on changed, as far as they know: all go stale, and the gate is told.
		for (const id of held) {
			await intentStub(env, id).act({ a: "stale" }, "type surface of something changed");
			await landing(env).noteStale(id);
		}
		await gateIdle(60_000);
		expect(await Promise.all(held.map(statusOf))).toEqual(held.map(() => "landed"));

		const events = await hub(env).since(seq, 5000);
		for (const id of held) {
			const races = events.flatMap((event) => (event.t === "rederive.race" && event.id === id ? [[event.rebase, event.rederive, event.winner ?? null]] : []));
			expect(races).toEqual([["pending", "pending", null], ["pass", "pending", "rebase"]]);
		}
		// No agent was started for any of them, no fresh fork was made, and they did not each need a commit of their own.
		expect((await store.list()).some((name) => held.some((id) => name.startsWith(`${id}-r`)))).toBe(false);
		expect(events.filter((event) => event.t === "trunk.advanced").length).toBeLessThan(held.length);
		expect(events.some((event) => event.t === "human.needed")).toBe(false);
	}, 90_000);

	it("is failed, not re-derived by an agent and not sent to a person, when its rebase cannot pass", async () => {
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const plan = await planWorkload(env, store, { n: 12, seed: 99, overlapRate: 0 });
		const job = plan.jobs.find((candidate) => candidate.spec.kind === "body");
		if (job === undefined) {
			throw new Error("expected a body edit among 12");
		}
		const queued: string[] = [];
		const result = await runWorkloadIntent(env, store, job, { trunk, enqueue: async (intent) => void queued.push(intent.id) });
		expect(result).toEqual({ id: job.intentId, status: "queued" });
		expect(queued).toEqual([job.intentId]);
		const seq = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;

		// The gate has just rejected its rebase onto this very trunk, so there is nothing left to try.
		await intentStub(env, job.intentId).act({ a: "stale" }, "Text conflict with trunk in src/x.ts");
		await landing(env).noteStale(job.intentId, await store.head(trunk));
		await gateIdle(30_000);
		expect(await statusOf(job.intentId)).toBe("failed");
		const events = (await hub(env).since(seq, 5000)).filter((event) => "id" in event && event.id === job.intentId);
		expect(events.map((event) => event.t)).toEqual(["intent.status", "intent.status"]); // stale, failed: no race, no card
		expect((await store.list()).some((name) => name.startsWith(`${job.intentId}-r`))).toBe(false);
	}, 60_000);
});
