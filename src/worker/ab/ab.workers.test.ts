import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Intent } from "../../shared/types";
import { landing } from "../gate/client";
import { gateDeps, landIntent } from "../gate/land";
import { hub } from "../hub/publish";
import { intentStub } from "../intent/client";
import { getRepoStore } from "../ports";
import type { FileChanges } from "../ports/repo-store";
import { seededStore, startIntent } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { spawnInProcess } from "../workload/run";
import { buildReport } from "./report";
import { runAbMode } from "./run";

const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
const T02_REFERENCE = "premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired";

async function allEvents(): Promise<PremiseEvent[]> {
	return hub(env).since(0, 5000);
}

/** The task of the first agent Intent to land, and the ids of the agent Intents by task. */
async function landingOrder(events: PremiseEvent[]): Promise<string[]> {
	const taskOf = new Map(events.flatMap((event) => (event.t === "intent.created" && event.intent.kind === "agent" ? [[event.intent.id, event.intent.taskId] as const] : [])));
	return events.flatMap((event) => (event.t === "intent.status" && event.status === "landed" && taskOf.has(event.id) ? [taskOf.get(event.id) as string] : []));
}

describe("the A/B comparison, in memory, with 30 workload Intents", () => {
	it("the baseline ships the behavioural regressions; Premise, on the same work, ships none", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const spawn = spawnInProcess(env, getRepoStore(env), { concurrency: 15, backoffMs: 20 });
		const settle = async () => void (await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete").catch(() => undefined))));

		// ---- Baseline: fork, push, and land if the rebase is clean and it typechecks.
		const baseline = await runAbMode(env, { mode: "baseline", n: 30, seed: 7 }, { spawn, timeoutMs: 180_000, pollMs: 200 });
		await settle();
		const baseEvents = await allEvents();
		expect(baseline).toMatchObject({ mode: "baseline", n: 30, seed: 7, tasksDispatched: 12, finalTypecheckOk: true, brokenBuildsOnTrunk: 0 });
		// The t01 change landed first; the three Intents written against the old behaviour then rebased
		// cleanly, typechecked, and landed. Their reference tests are red on trunk.
		expect((await landingOrder(baseEvents))[0]).toBe("t01-null-expired");
		expect(baseline.behaviouralRegressionsOnTrunk).toBeGreaterThanOrEqual(1);
		expect(baseline.behaviouralRegressionsOnTrunk).toBe(3);
		expect(baseline.redReferenceTests).toContain(T02_REFERENCE);
		expect(baseline.redReferenceTests).toHaveLength(3);
		expect(baseline.tasksLanded).toBe(12);
		// It has no ledger, no premises and no re-derive, so none of that happened.
		expect(baseline.premisesBroken).toBe(0);
		expect(baseline.races).toEqual({ started: 0, rebaseWon: 0, rederiveWon: 0, failed: 0 });
		expect(baseEvents.some((event) => event.t === "claim.decision" || event.t === "premise.broken" || event.t === "rederive.race" || event.t === "push.checked")).toBe(false);
		expect(baseEvents.filter((event) => event.t === "gate.result").every((event) => event.t === "gate.result" && event.report.path === "baseline" && event.report.tests.passed.length === 0)).toBe(true);
		// Every text conflict is a person's job, and is counted as one.
		expect(baseline.humanMerges).toBe(baseline.rejected.textConflicts);
		expect(baseEvents.filter((event) => event.t === "human.needed")).toHaveLength(baseline.humanMerges);
		expect(baseline.ends.landed + baseline.ends.failed).toBe(42);
		expect(baseline.claimsLost).toBe(0);
		expect(await hub(env).mode()).toBe("baseline");

		// ---- Premise: the same tasks, the same workload, the same order.
		const premise = await runAbMode(env, { mode: "premise", n: 30, seed: 7 }, { spawn, timeoutMs: 240_000, pollMs: 200 });
		await settle();
		const premEvents = await allEvents();
		expect(premise).toMatchObject({ mode: "premise", n: 30, seed: 7, tasksDispatched: 12, finalTypecheckOk: true, brokenBuildsOnTrunk: 0 });
		expect((await landingOrder(premEvents))[0]).toBe("t01-null-expired");
		expect(premise.behaviouralRegressionsOnTrunk).toBe(0);
		expect(premise.redReferenceTests).toEqual([]);
		// The three were told their premise broke, and were re-derived.
		expect(premise.premisesBroken).toBeGreaterThanOrEqual(3);
		expect(premise.races.rederiveWon).toBe(3);
		expect(premise.tasksLanded).toBe(12);
		// One stalemate card was shown (two Intents wanted the same function) and nobody had to answer
		// it: the Intent went on by itself when the other landed. That is not a human merge.
		expect(premEvents.filter((event) => event.t === "human.needed").every((event) => event.t === "human.needed" && event.kind === "stalemate")).toBe(true);
		expect(premEvents.some((event) => event.t === "human.resolved")).toBe(false);
		expect(premise.humanMerges).toBe(0);
		// Text conflicts happen here too (the same workload goes in). Here each one becomes a stale Intent
		// that is rebased again or re-derived, not a person's job.
		expect(premise.rejected.textConflicts).toBeLessThanOrEqual(baseline.rejected.textConflicts + 3);
		expect(premise.falsePositiveRate).toBeLessThan(1);
		expect(await hub(env).mode()).toBe("premise");
		// The same workload went in both times.
		expect(premise.forksCreated).toBeGreaterThanOrEqual(42);
		expect(baseline.forksCreated).toBe(42);

		const report = buildReport(baseline, premise);
		expect(report.headline).toBe(`Baseline shipped 3 behavioural regressions and needed ${baseline.humanMerges} human merge${baseline.humanMerges === 1 ? "" : "s"}; Premise shipped 0 behavioural regressions and needed 0 human merges.`);
		expect(await landing(env).status()).toMatchObject({ queue: [], stale: [], rederiving: [] });
	}, 420_000);
});

describe("the baseline landing rule", () => {
	async function queued(store: ReturnType<typeof seededStore>, taskId: string, changes: FileChanges) {
		const started = await startIntent(env, store, taskId);
		for (const action of [{ a: "claim" }, { a: "granted" }] as const) {
			await started.api.act(action);
		}
		const commit = await store.commit(started.id, started.intent.baseCommit, changes, "work");
		await started.api.act({ a: "submit", commit });
		await started.api.act({ a: "check" });
		await started.api.act({ a: "queue" });
		return started;
	}

	it("lands what rebases cleanly and typechecks, even when it is behaviourally wrong", async () => {
		const store = seededStore();
		const deps = { gate: gateDeps(env, store, "trunk"), baseline: true };
		const t01 = await queued(store, "t01-null-expired", referencePatch("t01"));
		const t02 = await queued(store, "t02-audit-expired", referencePatch("t02"));
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		// Premise stops this one (see gate.workers.test.ts). The baseline does not look.
		const outcome = await landIntent(env, t02.id, "rebase", deps);
		expect(outcome).toMatchObject({ kind: "landed", report: { path: "baseline", ok: true, tests: { passed: [], failed: [] } } });
		expect((await store.readFile("trunk", "main", "src/auth/login.ts")) ?? "").toBe(referencePatch("t02")["src/auth/login.ts"]);
	}, 30_000);

	it("turns a text conflict into a person's job, and a type error back to its author", async () => {
		const store = seededStore();
		const deps = { gate: gateDeps(env, store, "trunk"), baseline: true };
		const login = demoFiles()["src/auth/login.ts"] ?? "";
		const first = await queued(store, "t02-audit-expired", { "src/auth/login.ts": login.replace(/\n/g, "\n// one\n") });
		const second = await queued(store, "t03-expired-metrics", { "src/auth/login.ts": login.replace(/\n/g, "\n// two\n") });
		const broken = await queued(store, "t07-role-check", { "src/util/extra.ts": 'export const n: number = "no";\n' });
		const before = (await hub(env).metrics()).humanMerges;
		expect((await landIntent(env, first.id, "rebase", deps)).kind).toBe("landed");

		expect((await landIntent(env, second.id, "rebase", deps)).kind).toBe("failed");
		const status = async (id: string): Promise<Intent["status"]> => (await intentStub(env, id).get()).status;
		expect(await status(second.id)).toBe("failed");
		const about = (await hub(env).since(0, 5000)).filter((event) => "id" in event && event.id === second.id);
		expect(about.find((event) => event.t === "human.needed")).toMatchObject({ kind: "fallback", message: expect.stringMatching(/^Text conflict with trunk in src\/auth\/login\.ts\. Someone has to merge this by hand\.$/) });
		expect((await hub(env).metrics()).humanMerges).toBe(before + 1);

		expect((await landIntent(env, broken.id, "rebase", deps)).kind).toBe("failed");
		expect(await status(broken.id)).toBe("failed");
		expect((await hub(env).metrics()).humanMerges).toBe(before + 1); // a type error is not a merge
	}, 30_000);
});

describe("POST /api/admin/ab", () => {
	it("needs the admin token and a mode", async () => {
		const call = (path: string, body: unknown, headers: Record<string, string> = ADMIN) => exports.default.fetch(`http://premise.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
		const noToken = await call("/api/admin/ab", { mode: "premise" }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();
		for (const body of [{}, { mode: "both" }, { mode: "premise", n: -1 }, { mode: "baseline", n: 1.5 }]) {
			const response = await call("/api/admin/ab", body);
			expect(response.status).toBe(400);
			await response.text();
		}
		const result = await call("/api/admin/ab/result", { mode: "premise" });
		expect(await result.json()).toMatchObject({ ok: true, quiet: expect.any(Boolean), counts: expect.any(Object) });
	});
});
