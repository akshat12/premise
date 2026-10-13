import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import type { Metrics } from "../../shared/types";
import type { IntentDiff } from "../diff/intent-diff";
import { isTrunkCopy, resetDemo, staleTrunks } from "../dispatch";
import type { LandingStatus } from "../gate/client";
import { currentTrunk, hub } from "../hub/publish";
import type { RegistryRow } from "../metrics";
import { getRepoStore } from "../ports";
import { AT_REST, PUBLIC_RUN, type PublicRunStatus } from "./public-run";

const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
const call = (path: string, init?: RequestInit) => exports.default.fetch(`http://premise.test${path}`, init);
const get = async <T>(path: string) => (await (await call(path)).json()) as T;
// The hub stamps resets and events with the real clock, so the tests' own times are taken from it: T0 is two hours ago.
const T0 = Date.now() - 2 * 60 * 60_000;
const MIN = 60_000;

interface StartAnswer {
	ok: boolean;
	reason?: string;
	startedAt?: number;
	status: PublicRunStatus;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value) || Date.now() > deadline) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

describe("the hub's record of public runs", () => {
	// A hub of its own: nothing here touches the board the other tests share.
	const own = hub(env, "public-run-test");

	it("gives exactly one of two claims made together", async () => {
		const [a, b] = await Promise.all([own.claimPublicRun(false, T0), own.claimPublicRun(false, T0)]);
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		const refused = a.ok ? b : a;
		expect(!refused.ok && refused.status.reason).toBe("running");
	});

	it("keeps the record through a reset, and counts the reset as a run starting", async () => {
		const before = await own.publicRun(false, T0 + 10 * MIN);
		expect(before).toMatchObject({ canStart: true, startsToday: 1, lastStartAt: T0 });
		await own.reset();
		const now = Date.now();
		expect(await own.publicRun(false, now)).toMatchObject({ startsToday: 1, lastStartAt: T0, running: true, starting: true, reason: "running" });
		// Once the starting time has passed with nothing dispatched, the board is simply empty.
		expect(await own.publicRun(false, now + PUBLIC_RUN.startingMs + 1000)).toMatchObject({ running: false, canStart: true });
	});

	it("does not count a reset nobody asked for", async () => {
		await own.reset(false);
		expect(await own.publicRun(false, Date.now() + 1000)).toMatchObject({ running: false, starting: false, canStart: true });
		await own.reset();
		expect(await own.publicRun(false, Date.now() + 1000)).toMatchObject({ running: true, starting: true });
		await own.reset(false);
	});

	it("counts Intents that have not come to rest, and the gate's word, as a run in progress", async () => {
		await own.publish({ t: "intent.created", intent: { id: "i0000000a", kind: "agent", taskId: "t01", status: "planning" } as never });
		expect(await own.publicRun(false, Date.now() + 1000)).toMatchObject({ running: true, starting: false, reason: "running" });
		for (const status of AT_REST) {
			await own.publish({ t: "intent.status", id: "i0000000a", status } as never);
			expect(await own.publicRun(false, Date.now() + 1000), status).toMatchObject({ running: false, canStart: true });
		}
		// Only the gate knows it still has something in hand. The log is recent, so this is not a stuck run.
		expect(await own.publicRun(true, Date.now() + 1000)).toMatchObject({ running: true, reason: "running" });
	});

	it("can be switched off and on, and the switch survives a reset", async () => {
		await own.setPublicRuns(false);
		await own.reset();
		const later = Date.now() + 10 * MIN;
		expect(await own.publicRun(false, later)).toMatchObject({ enabled: false, canStart: false, reason: "off" });
		expect((await own.claimPublicRun(false, later)).ok).toBe(false);
		await own.setPublicRuns(true);
		expect(await own.publicRun(false, later)).toMatchObject({ enabled: true, canStart: true });
	});

	it("records a failed start, which ends the wait for it but not the cooldown", async () => {
		const at = Date.now() + 20 * MIN;
		const claim = await own.claimPublicRun(false, at);
		expect(claim.ok).toBe(true);
		expect(await own.publicRun(false, at + 1000)).toMatchObject({ running: true, starting: true });
		await own.publicRunFailed(at, "the fresh trunk is importing, not ready");
		expect(await own.publicRun(false, at + 1000)).toMatchObject({ running: false, reason: "cooldown", failed: true, nextAt: at + PUBLIC_RUN.cooldownMs });
	});

	it("says a reset has begun before the board is cleared, and forgets it if the reset is abandoned", async () => {
		await own.setPublicRuns(true, true);
		await own.reset(false);
		await own.publish({ t: "intent.created", intent: { id: "i0000000b", kind: "agent", taskId: "t01", status: "landed" } as never });
		const soon = Date.now() + 1000;
		expect(await own.publicRun(false, soon)).toMatchObject({ canStart: true, running: false });
		await own.resetBegun();
		expect(await own.publicRun(false, soon)).toMatchObject({ canStart: false, reason: "running", starting: true });
		expect((await own.claimPublicRun(false, soon)).ok).toBe(false);
		await own.resetAbandoned();
		expect(await own.publicRun(false, soon)).toMatchObject({ canStart: true });
		// A reset that goes through ends the "begun" state by itself, and the usual few seconds of grace follow.
		await own.resetBegun();
		await own.reset();
		expect(await own.publicRun(false, Date.now() + 1000)).toMatchObject({ starting: true });
		expect(await own.publicRun(false, Date.now() + PUBLIC_RUN.resetGraceMs + 1000)).toMatchObject({ canStart: true, running: false });
		await own.reset(false);
	});

	it("asks again before a claimed start resets the board, and records a refusal as a failed start", async () => {
		await own.setPublicRuns(true, true);
		const at = Date.now() + 2 * 60 * MIN;
		expect((await own.claimPublicRun(false, at)).ok).toBe(true);
		expect(await own.confirmPublicRun(at, false, at + 1000)).toBeNull();
		// Switched off a second after the claim: the start does not go ahead, and nothing waits for it.
		await own.setPublicRuns(false);
		expect(await own.confirmPublicRun(at, false, at + 1500)).toMatch(/switched off/);
		await own.setPublicRuns(true);
		expect(await own.publicRun(false, at + 2000)).toMatchObject({ failed: true, starting: false, reason: "cooldown" });
		// And once refused it stays refused.
		expect(await own.confirmPublicRun(at, false, at + 2500)).toMatch(/no longer the latest/);
		await own.setPublicRuns(true, true);
		expect(await own.publicRun(false, at + 3000)).toMatchObject({ canStart: true, startsToday: 0, failed: false });
	});

	it("refuses when a model has been chosen for the agents", async () => {
		const later = Date.now() + 3 * 60 * MIN;
		await own.setLlm({ provider: "google", model: "gemini-3.5-flash-lite" });
		expect(await own.publicRun(false, later)).toMatchObject({ canStart: false, reason: "model" });
		expect((await own.claimPublicRun(false, later)).ok).toBe(false);
		await own.setLlm(null);
		expect(await own.publicRun(false, later)).toMatchObject({ canStart: true });
	});
});

describe("the hub's record of runs", () => {
	const own = hub(env, "run-record-test");
	const created = (id: string, kind: "agent" | "workload") => own.publish({ t: "intent.created", intent: { id, kind, taskId: kind === "agent" ? "t01" : "workload", status: "planning" } as never });
	const status = (id: string, to: string) => own.publish({ t: "intent.status", id, status: to } as never);

	it("has nothing to list on a board nothing has run on", async () => {
		expect(await own.runs()).toEqual({ current: null, past: [] });
	});

	it("lists the run on the board, and keeps it as a line when the board is cleared", async () => {
		await created("i000000a1", "agent");
		await created("i000000a2", "agent");
		await created("i000000w1", "workload");
		expect((await own.runs()).current).toMatchObject({ id: 0, origin: "owner", complete: false, agents: { total: 2, landed: 0 }, workload: { total: 1, landed: 0 } });
		await status("i000000a1", "landed");
		await status("i000000a2", "landed");
		await status("i000000w1", "failed");
		expect((await own.runs()).current).toMatchObject({ complete: true, agents: { total: 2, landed: 2 }, workload: { total: 1, landed: 0 }, problems: 0 });

		// Cleared by a visitor's start: the run that was there is kept, and the next one is the visitor's.
		await own.reset(true, "visitor");
		const after = await own.runs();
		expect(after.current).toBeNull();
		expect(after.past).toHaveLength(1);
		expect(after.past[0]).toMatchObject({ origin: "owner", complete: true, agents: { total: 2, landed: 2 } });
		expect(after.past[0]?.id).toBeGreaterThan(0);

		await created("i000000b1", "agent");
		expect((await own.runs()).current).toMatchObject({ origin: "visitor", complete: false });
		await own.reset();
		const later = await own.runs();
		expect(later.past.map((run) => run.origin)).toEqual(["visitor", "owner"]);
		expect(later.past[0]).toMatchObject({ complete: false, agents: { total: 1, landed: 0 } });
		expect(later.past[0]?.id).toBeGreaterThan(later.past[1]?.id ?? 0);
	});

	it("keeps a past run's events, in order, so that it can be played again", async () => {
		await created("i000000e1", "agent");
		await status("i000000e1", "working");
		await status("i000000e1", "landed");
		const live = await own.since(0);
		await own.reset();
		const kept = (await own.runs()).past[0];
		expect(kept?.events).toBe(live.length);
		const events = await own.runEvents(kept?.id ?? 0);
		expect(events).toEqual(live);
		// A page at a time, as the page asks for it.
		expect(await own.runEvents(kept?.id ?? 0, live[0]?.seq ?? 0, 1)).toEqual([live[1]]);
		expect(await own.runEvents(999_999)).toEqual([]);
		// The board itself is empty again: the kept events are a copy.
		expect(await own.since(0)).toEqual([]);
	});

	it("names the trunk a kept run was on, and finds where its Intents landed there", async () => {
		const gated = (intentId: string, landedCommit: string | null) => own.publish({ t: "gate.result", report: { intentId, landedCommit, ok: landedCommit !== null } as never });
		const advanced = (commit: string, byIntent: string) => own.publish({ t: "trunk.advanced", commit, byIntent, changedSymbols: [] });
		await own.setTrunk("trunk-first");
		await own.publish({ t: "intent.created", intent: { id: "i000000f1", kind: "agent", taskId: "t01", status: "planning", baseCommit: "c0" } as never });
		await own.publish({ t: "intent.created", intent: { id: "i000000f2", kind: "agent", taskId: "t02", status: "planning", baseCommit: "c0" } as never });
		await own.publish({ t: "intent.created", intent: { id: "i000000f3", kind: "agent", taskId: "t03", status: "planning", baseCommit: "c0" } as never });
		await gated("i000000f1", "c1");
		await advanced("c1", "i000000f1");
		await gated("i000000f2", "c2");
		await advanced("c2", "i000000f2");
		await gated("i000000f3", null);
		// The run on the board is not a past one, so it has no trunk to name yet.
		expect((await own.runs()).current).not.toHaveProperty("trunk");

		// As a reset of the demo does it: the hub is already pointed at the fresh trunk, and is told which one the run was on.
		await own.setTrunk("trunk-second");
		await own.reset(true, "owner", "trunk-first");
		const first = (await own.runs()).past[0];
		expect(first).toMatchObject({ trunk: "trunk-first" });
		const id = first?.id ?? 0;
		expect(await own.runLanding(id, "i000000f1")).toEqual({ trunk: "trunk-first", landing: { commit: "c1", parent: "c0", together: 1 } });
		expect(await own.runLanding(id, "i000000f2")).toEqual({ trunk: "trunk-first", landing: { commit: "c2", parent: "c1", together: 1 } });
		// It was in the run and did not land: the run is known, the landing is not.
		expect(await own.runLanding(id, "i000000f3")).toEqual({ trunk: "trunk-first", landing: null });
		expect(await own.runLanding(999_999, "i000000f1")).toBeNull();

		// A board cleared without a new trunk was on the one still in use.
		await created("i000000g1", "agent");
		await own.reset();
		expect((await own.runs()).past[0]).toMatchObject({ trunk: "trunk-second" });
		const kept = await own.keptTrunks();
		expect(kept).toContain("trunk-first");
		expect(kept).toContain("trunk-second");
		expect(new Set(kept).size).toBe(kept.length);
	});

	it("a reset removes the trunk copies no kept run was on, and nothing else", () => {
		expect(isTrunkCopy("trunk-mgq1x2ab")).toBe(true);
		for (const name of ["trunk", "trunk-", "trunk-ABC", "trunkish-1", "i3k9x0a2q", "acme-accounts"]) {
			expect(isTrunkCopy(name), name).toBe(false);
		}
		const names = ["acme-accounts", "i3k9x0a2q", "trunk", "trunk-a1", "trunk-b2", "trunk-c3", "trunk-d4"];
		expect(staleTrunks(names, "trunk-d4", ["trunk-b2", "trunk"])).toEqual(["trunk-a1", "trunk-c3"]);
		expect(staleTrunks(names, "trunk", [])).toEqual(["trunk-a1", "trunk-b2", "trunk-c3", "trunk-d4"]);
		expect(staleTrunks([], "trunk-d4", ["trunk-b2"])).toEqual([]);
	});

	it("does not keep a comparison run, or an empty board", async () => {
		const before = (await own.runs()).past.length;
		await own.reset();
		expect((await own.runs()).past).toHaveLength(before);
		// A run under one of the other two rules is not one of Premise's runs.
		await own.setMode("baseline");
		await created("i000000c1", "agent");
		expect((await own.runs()).current).toBeNull();
		await own.reset();
		expect((await own.runs()).past).toHaveLength(before);
	});

	it("keeps only the most recent runs", async () => {
		for (let run = 0; run < 34; run++) {
			await created(`i00000d${run.toString(36).padStart(2, "0")}`, "agent");
			await own.reset();
		}
		const { past } = await own.runs();
		expect(past).toHaveLength(30);
		expect(past[0]?.id).toBe((past[29]?.id ?? 0) + 29);
		// The events of a run that has dropped off the list go with it.
		expect(await own.runEvents((past[29]?.id ?? 0) - 1)).toEqual([]);
		expect((await own.runEvents(past[29]?.id ?? 0)).length).toBeGreaterThan(0);
	});
});

describe("GET /api/live and POST /api/live/start", () => {
	afterAll(async () => {
		await hub(env).setLlm(null);
		await hub(env).setPublicRuns(true);
		// The run below lands every task on the trunk all the Worker tests share, and leaves its claims in the ledger.
		// The tests that come after this file start from a fresh trunk, as they would have without it.
		await resetDemo(env);
	});

	it("answers only GET and POST, and takes no token", async () => {
		expect((await call("/api/live", { method: "POST" })).status).toBe(405);
		expect((await call("/api/live/start")).status).toBe(405);
		expect((await call("/api/live/start", { method: "DELETE" })).status).toBe(405);
		const response = await call("/api/live");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({ enabled: true, dailyCap: PUBLIC_RUN.dailyCap, workload: PUBLIC_RUN.workload });
	});

	it("the switch needs the admin token", async () => {
		expect((await call("/api/admin/public-runs", { method: "POST", body: JSON.stringify({ enabled: false }) })).status).toBe(401);
		expect((await call("/api/admin/public-runs", { method: "POST", headers: ADMIN, body: JSON.stringify({ enabled: "no" }) })).status).toBe(400);
		expect((await call("/api/admin/public-runs", { method: "POST", headers: ADMIN, body: JSON.stringify({ enabled: true, clear: "yes" }) })).status).toBe(400);
		expect((await get<PublicRunStatus>("/api/live")).enabled).toBe(true);
	});

	it("refuses to start when switched off, or when the agents are a model, and starts nothing", async () => {
		// Whatever the tests before this one left running is cleared, and the reset is given time to stop counting as a start.
		await resetDemo(env);
		const events = async () => (await hub(env).since(0, 5000)).length;
		const before = await events();

		expect((await call("/api/admin/public-runs", { method: "POST", headers: ADMIN, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
		const off = await call("/api/live/start", { method: "POST" });
		expect(off.status).toBe(403);
		expect(await off.json()).toMatchObject({ ok: false, reason: "off" });
		expect((await call("/api/admin/public-runs", { method: "POST", headers: ADMIN, body: JSON.stringify({ enabled: true }) })).status).toBe(200);

		await hub(env).setLlm({ provider: "google", model: "gemini-3.5-flash-lite" });
		const model = await call("/api/live/start", { method: "POST" });
		expect(model.status).toBe(403);
		expect(await model.json()).toMatchObject({ ok: false, reason: "model" });
		await hub(env).setLlm(null);

		expect(await events()).toBe(before);
		expect(await hub(env).registry()).toEqual([]);
	});

	it("starts one run for any number of requests, ignores what the caller sends, and the run lands everything", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		// The reset in the test above still counts as "starting" for a minute. A public start waits it out; here the clock is not ours to move,
		// so the board is given what ends that state: an Intent that came to rest.
		await hub(env).publish({ t: "intent.created", intent: { id: "i0000000z", kind: "workload", taskId: "workload", status: "landed" } as never });
		expect(await hub(env).publicRun(false)).toMatchObject({ canStart: true });

		// A body that asks for a thousand Intents and a model is not read.
		const body = JSON.stringify({ n: 1000, workload: 1000, seed: 99, taskIds: ["t01-null-expired"], provider: "google", mode: "baseline" });
		const answers = await Promise.all(Array.from({ length: 5 }, () => call("/api/live/start", { method: "POST", headers: { "content-type": "application/json" }, body })));
		const parsed = (await Promise.all(answers.map((response) => response.json()))) as StartAnswer[];
		expect(answers.map((response) => response.status).sort()).toEqual([202, 429, 429, 429, 429]);
		expect(parsed.filter((answer) => answer.ok)).toHaveLength(1);
		expect(parsed.filter((answer) => !answer.ok).every((answer) => answer.reason === "running")).toBe(true);
		expect(await get<PublicRunStatus>("/api/live")).toMatchObject({ running: true, canStart: false, reason: "running", startsToday: 1 });

		// The run reaches the board: every task in the demo repo, and the fixed workload, in the product's own mode.
		const registry = await until(
			() => hub(env).registry(),
			(rows) => rows.filter((row) => row.kind === "agent").length === 12 && rows.filter((row) => row.kind === "workload").length === PUBLIC_RUN.workload,
			60_000,
		);
		expect(registry.filter((row) => row.kind === "agent")).toHaveLength(12);
		expect(registry.filter((row) => row.kind === "workload")).toHaveLength(PUBLIC_RUN.workload);
		expect(registry.some((row) => row.id === "i0000000z")).toBe(false);
		expect(await hub(env).mode()).toBe("premise");
		expect(await get<PublicRunStatus>("/api/live")).toMatchObject({ running: true, starting: false, reason: "running" });
		expect((await call("/api/live/start", { method: "POST" })).status).toBe(429);
		// The owner cannot point the agents at a model while this run is going: the rest of it would call the model.
		const model = await call("/api/admin/llm", { method: "POST", headers: ADMIN, body: JSON.stringify({ provider: "google", model: "gemini-3.5-flash-lite" }) });
		expect([400, 409]).toContain(model.status);
		expect(await hub(env).llm()).toBeNull();

		// And it ends by itself, with every agent's Intent on trunk and nothing broken there.
		const rest = (rows: RegistryRow[]) => rows.length > 0 && rows.every((row) => (AT_REST as readonly string[]).includes(row.status));
		const done = await until(
			async () => ({ registry: await hub(env).registry(), gate: await get<LandingStatus>("/api/gate") }),
			(state) => rest(state.registry) && !state.gate.busy && state.gate.queue.length === 0 && state.gate.stale.length === 0 && state.gate.rederiving.length === 0,
			240_000,
		);
		const agents = done.registry.filter((row) => row.kind === "agent");
		expect(agents.map((row) => row.status)).toEqual(Array.from({ length: 12 }, () => "landed"));
		const metrics = await get<Metrics>("/api/metrics");
		expect(metrics).toMatchObject({ brokenBuildsOnTrunk: 0, behaviouralRegressionsOnTrunk: 0 });
		expect(metrics.premisesBroken).toBeGreaterThan(0);

		// Over, and the next start has to wait out the cooldown.
		const after = await until(() => get<PublicRunStatus>("/api/live"), (status) => !status.running, 10_000);
		expect(after).toMatchObject({ running: false, canStart: false, reason: "cooldown", failed: false });
		expect(after.nextAt).toBe((after.lastStartAt ?? 0) + PUBLIC_RUN.cooldownMs);
		const again = await call("/api/live/start", { method: "POST" });
		expect(again.status).toBe(429);
		expect(await again.json()).toMatchObject({ ok: false, reason: "cooldown" });
		// The owner can give the wait back.
		expect((await call("/api/admin/public-runs", { method: "POST", headers: ADMIN, body: JSON.stringify({ enabled: true, clear: true }) })).status).toBe(200);
		expect(await get<PublicRunStatus>("/api/live")).toMatchObject({ canStart: true, startsToday: 0 });

		// The run is on the list as the one on the board, started by a visitor; cleared, it is the first of the past ones.
		const listed = await hub(env).runs();
		expect(listed.current).toMatchObject({ id: 0, origin: "visitor", complete: true, agents: { total: 12, landed: 12 }, workload: { total: PUBLIC_RUN.workload }, problems: 0, scripted: true });
		expect(listed.current?.premisesBroken).toBeGreaterThan(0);
		const route = await call("/api/runs");
		expect(route.status).toBe(200);
		expect(((await route.json()) as { current: unknown }).current).toMatchObject({ origin: "visitor", agents: { total: 12, landed: 12 } });
		expect((await call("/api/runs", { method: "POST" })).status).toBe(405);
		const pastBefore = listed.past.length;
		const store = getRepoStore(env);
		const ranOn = await currentTrunk(env);
		// A copy of trunk that no run was on, as a reset that stopped half way could leave behind.
		await store.ensureRepo("trunk-stray0");
		await resetDemo(env);
		const cleared = await hub(env).runs();
		expect(cleared.current).toBeNull();
		expect(cleared.past).toHaveLength(Math.min(30, pastBefore + 1));
		expect(cleared.past[0]).toMatchObject({ origin: "visitor", complete: true, agents: { total: 12, landed: 12 }, problems: 0 });
		// And its log can be fetched again, a page at a time, by anyone; a run that was never kept is a 404.
		const id = cleared.past[0]?.id ?? 0;
		const page = await call(`/api/runs/${id}/events?since=0&limit=50`);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toMatch(/max-age=3600/);
		const first = (await page.json()) as { seq: number; t: string }[];
		expect(first).toHaveLength(50);
		expect(first.map((event) => event.seq)).toEqual([...first.map((event) => event.seq)].sort((a, b) => a - b));
		expect(cleared.past[0]?.events).toBeGreaterThan(200);
		expect((await call("/api/runs/999999/events")).status).toBe(404);
		expect((await call(`/api/runs/${id}/events`, { method: "POST" })).status).toBe(405);
		expect((await call("/api/runs/0/events")).status).toBe(404);

		// The run's forks are gone with the reset, and its trunk is not: what each Intent changed is read from its landing there.
		expect(cleared.past[0]).toMatchObject({ trunk: ranOn });
		const repos = await store.list();
		expect(repos).toContain(ranOn);
		expect(repos).toContain(await currentTrunk(env));
		expect(await currentTrunk(env)).not.toBe(ranOn);
		expect(repos).not.toContain("trunk-stray0");
		expect(repos.some((name) => /^i[0-9a-z]{8}/.test(name))).toBe(false);
		for (const agent of agents) {
			const response = await call(`/api/runs/${id}/intents/${agent.id}/diff`);
			expect(response.status, agent.id).toBe(200);
			expect(response.headers.get("cache-control")).toMatch(/max-age=3600/);
			const diff = (await response.json()) as IntentDiff;
			expect(diff, agent.id).toMatchObject({ intentId: agent.id });
			expect(diff.unavailable, agent.id).toBeUndefined();
			expect(diff.together, agent.id).toBeUndefined();
			expect(diff.files.length, agent.id).toBeGreaterThan(0);
			expect(diff.files.every((file) => !file.path.startsWith(".intent/"))).toBe(true);
			expect(diff.base).not.toBe(diff.head);
		}
		// Two agents did different work, so their landings are different commits with different changes.
		const [one, two] = (await Promise.all(agents.slice(0, 2).map((agent) => get<IntentDiff>(`/api/runs/${id}/intents/${agent.id}/diff`)))) as [IntentDiff, IntentDiff];
		expect(one.head).not.toBe(two.head);
		// A workload Intent that landed has a diff too, and says so when its commit carried others; one that did not land has none.
		const workload = done.registry.filter((row) => row.kind === "workload");
		const landedWork = workload.filter((row) => row.status === "landed");
		expect(landedWork.length).toBeGreaterThan(0);
		for (const row of landedWork) {
			const diff = await get<IntentDiff>(`/api/runs/${id}/intents/${row.id}/diff`);
			expect(diff.unavailable, row.id).toBeUndefined();
			expect(diff.together === undefined || diff.together > 1, row.id).toBe(true);
		}
		for (const row of workload.filter((entry) => entry.status !== "landed")) {
			expect((await call(`/api/runs/${id}/intents/${row.id}/diff`)).status, row.id).toBe(404);
		}
		expect((await call(`/api/runs/${id}/intents/i0000000q/diff`)).status).toBe(404);
		expect((await call(`/api/runs/999999/intents/${agents[0]?.id}/diff`)).status).toBe(404);
		expect((await call(`/api/runs/${id}/intents/${agents[0]?.id}/diff`, { method: "POST" })).status).toBe(405);

		// The next reset keeps that trunk as well: the run is still one of those kept.
		await resetDemo(env);
		expect(await store.list()).toContain(ranOn);
		expect((await call(`/api/runs/${id}/intents/${agents[0]?.id}/diff`)).status).toBe(200);
		void introspector;
	}, 320_000);
});
