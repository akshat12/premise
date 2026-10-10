import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { newIntentId } from "../../shared/ids";
import type { AcceptanceCheck, Assertion, Claim, Intent, Premise } from "../../shared/types";
import { type AgentDeps, runAgent } from "../agent/run";
import { resetDemo } from "../dispatch";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { requestClaimsAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import type { LlmMessage } from "../ports/llm";
import type { FileChanges } from "../ports/repo-store";
import { demoTask, memorySteps, replay, scriptFor, seededStore, startIntent } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { landing } from "./client";

const VERIFY = "src/auth/session.ts#verifySession";
const LOGIN = "src/auth/login.ts#handleLogin";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;
const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };

interface Built {
	id: string;
	api: IntentApi;
}

/**
 * An Intent on the store the Worker itself uses, taken by hand to `queued` with `changes` pushed
 * to its fork. Nothing has sent it to the gate yet.
 */
async function queuedOnTrunk(taskId: string, changes: FileChanges, options: { claims?: Claim[]; premises?: Premise[]; acceptance?: AcceptanceCheck[] } = {}): Promise<Built> {
	const store = getRepoStore(env);
	const trunk = await currentTrunk(env);
	const task = demoTask(taskId);
	const id = newIntentId();
	const { head } = await store.fork(trunk, id);
	const api = intentStub(env, id);
	await api.init(newIntent({ id, kind: "agent", taskId, goal: task.goal, acceptance: options.acceptance ?? structuredClone(task.acceptance), baseCommit: head }));
	if (options.claims !== undefined) {
		expect(await requestClaimsAcrossShards(env, { intentId: id, claims: options.claims, priority: 5, dependsOn: [] })).toEqual({ kind: "granted" });
		await api.setClaims(options.claims);
	}
	await api.recordPremises(options.premises ?? []);
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
		if (wanted.includes(intent.status) || Date.now() > deadline) {
			return intent;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function gateIdle(timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await landing(env).status();
		if ((status.queue.length === 0 && !status.busy && status.stale.length === 0 && status.rederiving.length === 0) || Date.now() > deadline) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const about = (id: string) => (event: PremiseEvent) =>
	("id" in event && event.id === id) || (event.t === "gate.result" && event.report.intentId === id) || (event.t === "trunk.advanced" && event.byIntent === id) || (event.t === "artifacts" && (event.repo === id || event.repo.startsWith(`${id}-r`)));
const races = (events: PremiseEvent[]) => events.flatMap((event) => (event.t === "rederive.race" ? [[event.rebase, event.rederive, event.winner ?? null]] : []));
const statuses = (events: PremiseEvent[]) => events.flatMap((event) => (event.t === "intent.status" ? [event.status] : []));

// These tests land things on the Worker's own trunk, so they start from a fresh one.
beforeAll(async () => {
	await gateIdle();
	await resetDemo(env);
});

describe("the re-derive race, on the demo scenario", () => {
	it("t01 lands, t02 goes stale, its rebase fails on behaviour, and its re-derive lands", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const before = (await hub(env).metrics()).rederives;

		// t02 is written against the trunk where verifySession throws, and says that it relies on that.
		const t02 = await queuedOnTrunk("t02-audit-expired", referencePatch("t02"), {
			claims: [{ symbol: LOGIN, mode: "body" }],
			premises: [{ symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS }],
		});
		const t01 = await queuedOnTrunk("t01-null-expired", referencePatch("t01"));

		// 1. t01 goes through the gate and lands. Everything after that happens by itself.
		await landing(env).enqueue(t01.id);
		const landed = await waitFor(t02.api, ["landed", "escalated", "failed"], 45_000);
		await gateIdle();
		expect((await t01.api.get()).status).toBe("landed");
		expect(landed.status).toBe("landed");

		// 4. What landed is the re-derived work, from the fresh fork, not the original.
		expect(landed).toMatchObject({ rederiveAttempts: 1, repo: `${t02.id}-r1` });
		expect(await store.readFile(trunk, "main", "src/auth/login.ts")).toBe(referencePatch("t02-rederived")["src/auth/login.ts"]);
		expect(await store.readFile(trunk, "main", "src/auth/login.ts")).not.toBe(referencePatch("t02")["src/auth/login.ts"]);
		expect(await store.readFile(trunk, "main", "tests/audit-expired.test.ts")).not.toBeNull();
		// The broken assertion is gone from the Intent; it would never hold again.
		expect(landed.premises.some((premise) => premise.assertion?.id === SESSION_THROWS.id)).toBe(false);

		const events = (await hub(env).since(0, 5000)).filter(about(t02.id));
		// 2. t02 went stale because of what t01 changed.
		expect(events.find((event) => event.t === "premise.broken")).toMatchObject({ symbol: VERIFY, byIntent: t01.id, reason: `assertion '${SESSION_THROWS.description}' no longer holds after intent ${t01.id}` });
		expect(statuses(events)).toEqual(["claiming", "working", "submitted", "checking", "queued", "stale", "rederiving", "landed"]);
		// 3. The race: the rebase is tried first and fails; the re-derive passes and wins.
		expect(races(events)).toEqual([
			["pending", "pending", null],
			["fail", "pending", null],
			["fail", "pass", "rederive"],
		]);
		const reports = events.flatMap((event) => (event.t === "gate.result" ? [event.report] : []));
		expect(reports.map((report) => [report.path, report.textConflict, report.typecheck.ok, report.ok])).toEqual([
			["rebase", false, true, false],
			["rederive", false, true, true],
		]);
		expect(reports[0]?.tests.failed.map((failure) => failure.name)).toContain("an expired session writes an audit entry and returns expired");
		expect(reports[0]?.assertions.failed.map((failure) => failure.id)).toEqual([SESSION_THROWS.id]);
		expect(reports[1]?.tests.passed).toHaveLength(3);
		// The order things were announced in.
		const order = events.map((event) => (event.t === "rederive.race" ? `race:${event.rebase}/${event.rederive}` : event.t === "gate.result" ? `gate:${event.report.path}` : event.t === "artifacts" ? `${event.type}:${event.repo}` : event.t === "intent.status" ? event.status : event.t));
		const from = order.indexOf("stale");
		expect(order.slice(from, from + 6)).toEqual(["stale", "rederiving", "race:pending/pending", "gate:rebase", "race:fail/pending", `forked:${t02.id}-r1`]);
		expect(order.slice(-4)).toEqual(["gate:rederive", "landed", "trunk.advanced", "race:fail/pass"]);
		// 5. And it is counted.
		const after = (await hub(env).metrics()).rederives;
		expect([after.started - before.started, after.succeeded - before.succeeded, after.failed - before.failed]).toEqual([1, 1, 0]);

		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
	}, 90_000);

	it("lands the rebase, and starts no agent, when the old work still passes on the new trunk", async () => {
		const store = getRepoStore(env);
		// Stale for a reason that turns out not to matter: its pushed work is fine on trunk as it is.
		const intent = await queuedOnTrunk("t04-session-ttl-header", referencePatch("t04"));
		await intent.api.act({ a: "stale" }, "a premise broke");
		const seq = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;

		await landing(env).noteStale(intent.id);
		const landed = await waitFor(intent.api, ["landed", "escalated", "failed"], 30_000);
		await gateIdle();
		expect(landed).toMatchObject({ status: "landed", rederiveAttempts: 1, repo: intent.id });
		const events = (await hub(env).since(seq, 5000)).filter(about(intent.id));
		expect(races(events)).toEqual([
			["pending", "pending", null],
			["pass", "pending", "rebase"],
		]);
		expect(statuses(events)).toEqual(["rederiving", "landed"]);
		// No fresh fork was made and no agent was started.
		expect((await store.list()).filter((name) => name.startsWith(`${intent.id}-r`))).toEqual([]);
		expect(events.some((event) => event.t === "artifacts" && event.type === "forked")).toBe(false);
	}, 60_000);
});

describe("escalation", () => {
	it("after two failed re-derives a person is asked; Retry gives one more attempt; Abandon ends it", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const before = (await hub(env).metrics()).rederives;
		// An Intent that can never pass: its acceptance check names a test nobody will write. Its
		// task has no recorded re-derive, so each re-derive attempt fails as soon as it starts.
		const impossible: AcceptanceCheck[] = [{ id: "never", description: "cannot pass", testFile: "tests/never.test.ts", testName: "never" }];
		const intent = await queuedOnTrunk("t05-tax-rounding", { "README.md": `${demoFiles()["README.md"] ?? ""}\nA note.\n` }, { acceptance: impossible });

		// The gate rejects it, which makes it stale and starts the first race by itself.
		await landing(env).enqueue(intent.id);
		const escalated = await waitFor(intent.api, ["escalated", "landed", "failed"], 60_000);
		await gateIdle();
		expect(escalated).toMatchObject({ status: "escalated", rederiveAttempts: 2 });

		let events = (await hub(env).since(0, 5000)).filter(about(intent.id));
		expect(statuses(events)).toEqual(["claiming", "working", "submitted", "checking", "queued", "gating", "stale", "rederiving", "stale", "rederiving", "escalated"]);
		// Exactly two attempts. In neither did the rebase or the re-derive pass.
		expect(races(events)).toEqual([
			["pending", "pending", null],
			["fail", "pending", null],
			["fail", "fail", null],
			["pending", "pending", null],
			["fail", "pending", null],
			["fail", "fail", null],
		]);
		// The gate's own verdict is reused for the first rebase, so the same check is not run twice.
		expect(events.filter((event) => event.t === "gate.result")).toHaveLength(1);
		expect(events.filter((event) => event.t === "artifacts" && event.type === "forked").map((event) => event.t === "artifacts" && event.repo)).toEqual([`${intent.id}-r1`, `${intent.id}-r2`]);
		const asks = events.filter((event) => event.t === "human.needed");
		expect(asks).toMatchObject([{ kind: "fallback", options: ["Retry", "Abandon"] }]);
		expect(asks[0]?.t === "human.needed" && asks[0].message).toContain("re-derived 2 times");
		const counted = (await hub(env).metrics()).rederives;
		expect([counted.started - before.started, counted.succeeded - before.succeeded, counted.failed - before.failed]).toEqual([2, 0, 2]);

		// Retry: one more attempt, and when that fails too, back to a person.
		const retry = await exports.default.fetch(`http://premise.test/api/human/${intent.id}`, { method: "POST", headers: ADMIN, body: JSON.stringify({ choice: "Retry" }) });
		expect(await retry.json()).toMatchObject({ ok: true, choice: "Retry", status: "rederiving" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		const again = await waitFor(intent.api, ["escalated", "landed", "failed"], 60_000);
		await gateIdle();
		expect(again).toMatchObject({ status: "escalated", rederiveAttempts: 3 });
		events = (await hub(env).since(0, 5000)).filter(about(intent.id));
		expect(statuses(events).slice(-2)).toEqual(["rederiving", "escalated"]);
		expect(races(events)).toHaveLength(9);
		expect(events.filter((event) => event.t === "human.needed")).toHaveLength(2);
		expect(events.filter((event) => event.t === "human.resolved")).toMatchObject([{ choice: "Retry" }]);

		// Abandon: the Intent is over, and the gate has nothing left for it.
		const abandon = await exports.default.fetch(`http://premise.test/api/human/${intent.id}`, { method: "POST", headers: ADMIN, body: JSON.stringify({ choice: "Abandon" }) });
		expect(await abandon.json()).toMatchObject({ ok: true, choice: "Abandon", status: "failed" });
		expect((await intent.api.get()).status).toBe("failed");
		const status = await landing(env).status();
		expect([...status.queue, ...status.stale, ...status.rederiving].some((item) => item.intentId === intent.id)).toBe(false);

		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete").catch(() => undefined)));
	}, 180_000);
});

describe("the agent run in re-derive mode", () => {
	it("is told what broke, and reports failure to whoever started it instead of failing the Intent", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await started.api.act(action);
		}
		const attempt = (await started.api.incRederive()).rederiveAttempts;
		const fork = `${started.id}-r${attempt}`;
		const { head } = await store.fork("trunk", fork);
		await started.api.restartOn(fork, head);
		const broken: Premise[] = [{ symbol: VERIFY, source: "asserted", surfaceHash: null, state: "broken", assertion: SESSION_THROWS, brokenBy: { intentId: "ilander01", commit: "c".repeat(40), reason: "assertion 'x' no longer holds after intent ilander01" } }];

		const seen: LlmMessage[][] = [];
		const gaveUp: string[] = [];
		const deps: AgentDeps = {
			env,
			store,
			intent: started.api,
			llm: () => ({
				turn: async (_system, messages) => {
					seen.push(messages);
					throw new Error("the model is unavailable");
				},
			}),
			handOff: async () => undefined,
			giveUp: async (reason) => void gaveUp.push(reason),
		};
		const outcome = await runAgent(deps, { intentId: started.id, mode: "rederive", attempt, broken }, memorySteps());

		expect(outcome.result).toBe("failed");
		const briefing = seen[0]?.[0]?.content;
		expect(briefing).toContain("This is a re-derive.");
		expect(briefing).toContain(`- ${SESSION_THROWS.description}: assertion 'x' no longer holds after intent ilander01`);
		expect(gaveUp).toEqual([expect.stringContaining("the model is unavailable")]);
		// The Intent is still mid re-derive: the gate decides what happens next.
		expect((await started.api.get()).status).toBe("rederiving");
		await started.api.act({ a: "fail" }, "test cleanup");
	});

	it("a first attempt that is overtaken by a re-derive just before it pushes leaves the new fork alone", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t04-session-ttl-header");
		const fork = `${started.id}-r1`;
		const plain = memorySteps();
		let forkHead = "";
		// Everything runs normally until the push step, and at that moment the Intent goes stale and its re-derive begins.
		const steps: typeof plain = {
			...plain,
			async do(name, fn) {
				if (name === "push") {
					await started.api.act({ a: "stale" }, "a premise broke");
					await started.api.act({ a: "rederive" });
					await started.api.incRederive();
					forkHead = (await store.fork("trunk", fork)).head;
					await started.api.restartOn(fork, forkHead);
				}
				return plain.do(name, fn);
			},
		};
		const handedOff: string[] = [];
		const deps: AgentDeps = { env, store, intent: started.api, llm: replay(scriptFor("t04-session-ttl-header")), handOff: async (intent) => void handedOff.push(intent.id) };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);

		expect(outcome).toMatchObject({ result: "stopped", reason: "the Intent is rederiving" });
		// Nothing was pushed to either fork, the Intent was not failed, and nothing was sent to the gate.
		expect(await store.head(fork)).toBe(forkHead);
		expect(await store.head(started.id)).toBe(started.intent.baseCommit);
		expect(await started.api.get()).toMatchObject({ status: "rederiving", repo: fork, headCommit: null });
		expect(handedOff).toEqual([]);
		expect(plain.names).not.toContain("record-push");
		await started.api.act({ a: "fail" }, "test cleanup");
	});

	it("stops, without touching anything, once a later attempt has taken over", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await started.api.act(action);
		}
		await started.api.incRederive();
		await started.api.incRederive(); // attempt 2 is the current one
		let asked = 0;
		const deps: AgentDeps = { env, store, intent: started.api, llm: () => ({ turn: async () => Promise.reject(new Error(`asked ${++asked}`)) }), handOff: async () => undefined, giveUp: async () => undefined };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "rederive", attempt: 1 }, memorySteps());
		expect(outcome).toMatchObject({ result: "stopped", reason: "re-derive attempt 2 has taken over" });
		expect(asked).toBe(0);
		await started.api.act({ a: "fail" }, "test cleanup");
	});
});
