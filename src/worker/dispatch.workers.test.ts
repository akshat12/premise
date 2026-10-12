import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../shared/events";
import type { Intent, Metrics, TaskDef } from "../shared/types";
import { DispatchFailed, dispatchTasks, isIntentRepo, priorityFor, recoverMemoryStore, resetDemo } from "./dispatch";
import type { LandingStatus } from "./gate/client";
import { currentTrunk, hub } from "./hub/publish";
import { intentStub } from "./intent/client";
import type { LedgerSnapshot } from "./ledger/ledger-shard";
import type { RegistryRow } from "./metrics";
import { getRepoStore } from "./ports";

const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
const get = async <T>(path: string) => (await (await exports.default.fetch(`http://premise.test${path}`)).json()) as T;
const post = (path: string, body: unknown, headers: Record<string, string> = ADMIN) => exports.default.fetch(`http://premise.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });

async function waitForStatus(id: string, wanted: Intent["status"][], timeoutMs = 20_000): Promise<Intent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const intent = await intentStub(env, id).get();
		if (wanted.includes(intent.status) || Date.now() > deadline) {
			return intent;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Waits until the gate has nothing queued and nothing in hand. */
async function gateIdle(timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await get<LandingStatus>("/api/gate");
		if ((status.queue.length === 0 && !status.busy) || Date.now() > deadline) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("helpers", () => {
	it("priorityFor ranks tasks by their place in the order given", () => {
		expect(priorityFor("b", ["a", "b"])).toBe(2);
		expect(priorityFor("a", ["a", "b"])).toBe(1);
		expect(priorityFor("c", ["a", "b"])).toBeGreaterThan(2);
		expect(priorityFor("a", undefined)).toBe(5);
	});

	it("isIntentRepo recognises Intent forks and nothing else", () => {
		expect(["i3k9x0a2q", "i3k9x0a2q-r1", "i00000000-r12"].every(isIntentRepo)).toBe(true);
		expect(["trunk", "trunk-abc", "import", "i123", "i3k9x0a2q-x", "smoke-1-0-a"].some(isIntentRepo)).toBe(false);
	});
});

describe("read APIs", () => {
	it("GET /api/tasks returns the 12 tasks from trunk", async () => {
		const tasks = await get<TaskDef[]>("/api/tasks");
		expect(tasks).toHaveLength(12);
		expect(tasks[0]).toMatchObject({ id: "t01-null-expired", acceptance: expect.any(Array) });
	});

	it("GET /api/trunk names the current trunk and its head", async () => {
		expect(await get("/api/trunk")).toEqual({ repo: await currentTrunk(env), head: expect.stringMatching(/^[0-9a-f]{40}$/) });
	});

	it("GET /api/intents/:id is 404 for an Intent that does not exist", async () => {
		const response = await exports.default.fetch("http://premise.test/api/intents/i00000000");
		expect(response.status).toBe(404);
		await response.text();
	});
});

describe("POST /api/dispatch", () => {
	it("needs the admin token and a list of known tasks", async () => {
		const noToken = await post("/api/dispatch", { taskIds: ["t07-role-check"] }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();
		const unknown = await post("/api/dispatch", { taskIds: ["t07-role-check", "t99-nope"] });
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({ error: "unknown task id: t99-nope" });
		const empty = await post("/api/dispatch", { taskIds: [] });
		expect(empty.status).toBe(400);
		await empty.text();
		const wrongMethod = await exports.default.fetch("http://premise.test/api/dispatch");
		expect(wrongMethod.status).toBe(405);
		await wrongMethod.text();
	});

	it("dispatches two tasks: two Intents, two forks, two workflows, and both land on trunk through the gate", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const before = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;
		const trunk = await currentTrunk(env);
		const trunkHead = await getRepoStore(env).head(trunk);

		const response = await post("/api/dispatch", { taskIds: ["t07-role-check", "t09-currency-format"], priorityOrder: ["t09-currency-format"] });
		expect(response.status).toBe(200);
		const { intents: ids } = (await response.json()) as { intents: string[] };
		expect(ids).toHaveLength(2);
		expect(ids.every(isIntentRepo)).toBe(true);

		// Two forks exist, each starting at trunk's head.
		const store = getRepoStore(env);
		expect((await store.list()).filter((name) => ids.includes(name)).sort()).toEqual([...ids].sort());

		// Two workflows were started, one per Intent, and both run to completion.
		const instances = await introspector.get();
		expect(instances).toHaveLength(2);
		await Promise.all(instances.map((instance) => instance.waitForStatus("complete")));
		const outputs = await Promise.all(instances.map((instance) => instance.getOutput()));
		expect(outputs.every((output) => (output as { result: string }).result === "submitted")).toBe(true);

		const [role, currency] = await Promise.all(ids.map((id) => waitForStatus(id, ["landed", "failed", "stale"])));
		await gateIdle();
		expect(role).toMatchObject({ taskId: "t07-role-check", kind: "agent", status: "landed", baseCommit: trunkHead, repo: ids[0] });
		expect(currency).toMatchObject({ taskId: "t09-currency-format", status: "landed" });
		expect(role?.acceptance.map((check) => check.id)).toEqual(["t07-ac1", "t07-ac2", "t07-ac3"]);
		expect(await store.readFile(ids[0] ?? "", "main", "src/users/roles.ts")).toContain("export function canAccess(");
		// Trunk moved twice, and only through the gate: it now has both Intents' work.
		const newHead = await store.head(trunk);
		expect(newHead).not.toBe(trunkHead);
		expect([role?.headCommit, currency?.headCommit]).toContain(newHead);
		expect(await store.readFile(trunk, "main", "src/users/roles.ts")).toContain("export function canAccess(");
		expect(await store.readFile(trunk, "main", "tests/currency-format.test.ts")).not.toBeNull();

		// The events, in order, for one of the Intents.
		const events = (await hub(env).since(before, 5000)) as PremiseEvent[];
		const about = (id: string) => (event: PremiseEvent) =>
			("id" in event && event.id === id) || (event.t === "intent.created" && event.intent.id === id) || (event.t === "artifacts" && event.repo === id) || (event.t === "gate.result" && event.report.intentId === id) || (event.t === "trunk.advanced" && event.byIntent === id);
		const mine = events.filter(about(ids[0] ?? ""));
		expect(mine.map((event) => event.t).filter((t, index, all) => t !== all[index - 1])).toEqual(["artifacts", "intent.created", "premise.recorded", "intent.why", "intent.status", "claim.decision", "intent.status", "artifacts", "intent.status", "push.checked", "intent.status", "gate.result", "intent.status", "trunk.advanced"]);
		expect(mine[0]).toMatchObject({ t: "artifacts", type: "forked", detail: { source: trunk } });
		expect(mine.flatMap((event) => (event.t === "intent.status" ? [event.status] : []))).toEqual(["claiming", "working", "submitted", "checking", "queued", "gating", "landed"]);
		expect(mine.find((event) => event.t === "gate.result")).toMatchObject({ report: { path: "rebase", textConflict: false, typecheck: { ok: true }, ok: true } });
		expect(events.filter((event) => event.t === "metrics").length).toBeGreaterThanOrEqual(1);
		expect(events.filter((event) => event.t === "trunk.advanced" && ids.includes(event.byIntent ?? ""))).toHaveLength(2);

		// While they were in flight the ledger had them as the writers of what they declared, and as readers of what they read.
		const granted = events.flatMap((event) => (event.t === "claim.decision" && ids.includes(event.id) && event.decision.kind === "granted" ? event.symbols : []));
		expect(granted.sort()).toEqual(["src/billing/currency.ts#formatMoney", "src/users/roles.ts#RESOURCE_MINIMUM", "src/users/roles.ts#Resource", "src/users/roles.ts#canAccess"]);
		expect(mine.some((event) => event.t === "premise.recorded" && event.premise.symbol === "src/users/roles.ts#isAtLeast")).toBe(true);

		// Now that they have landed, the registry and the Intent API say so, and the ledger has let go of them.
		const registry = await get<RegistryRow[]>("/api/intents");
		expect(registry.filter((row) => ids.includes(row.id)).map((row) => [row.taskId, row.status, row.kind])).toEqual([["t07-role-check", "landed", "agent"], ["t09-currency-format", "landed", "agent"]]);
		expect(await get<Intent>(`/api/intents/${ids[0]}`)).toMatchObject({ id: ids[0], status: "landed" });
		const ledger = await get<LedgerSnapshot>("/api/ledger");
		expect(ledger.claims.filter((claim) => ids.includes(claim.intentId))).toEqual([]);
		expect(ledger.readers.filter((reader) => ids.includes(reader.intentId))).toEqual([]);

		const metrics = await get<Metrics>("/api/metrics");
		expect(metrics.forksCreated).toBeGreaterThanOrEqual(2);
		expect(metrics.pushes).toBeGreaterThanOrEqual(2);
		expect(metrics.intentsLanded).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("wakes a waiting agent when the Intent it waits on lands", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const before = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;
		// The same task twice: both want the same symbols, so the ledger makes one of them wait.
		const { intents: ids } = (await (await post("/api/dispatch", { taskIds: ["t08-profile-validation", "t08-profile-validation"] })).json()) as { intents: string[] };
		expect(ids).toHaveLength(2);

		// The one that got the symbols lands, which releases them and wakes the other. The wait itself
		// times out after 30 seconds, so finishing well inside that shows it was woken.
		const started = Date.now();
		const done = await Promise.all(ids.map((id) => waitForStatus(id, ["landed", "failed", "stale"], 25_000)));
		expect(done.map((intent) => intent.status)).toEqual(["landed", "landed"]);
		expect(Date.now() - started).toBeLessThan(25_000);

		const events = await hub(env).since(before, 5000);
		const statuses = (id: string) => events.flatMap((event) => (event.t === "intent.status" && event.id === id ? [event.status] : []));
		const waited = ids.filter((id) => statuses(id).includes("waiting"));
		expect(waited).toHaveLength(1);
		expect(statuses(waited[0] ?? "")).toEqual(["claiming", "waiting", "claiming", "working", "submitted", "checking", "queued", "gating", "landed"]);
		// It waited for the other one, and only started work after that one had landed.
		const other = ids.find((id) => id !== waited[0]) ?? "";
		const seqOf = (id: string, status: Intent["status"]) => events.find((event) => event.t === "intent.status" && event.id === id && event.status === status)?.seq ?? 0;
		expect(seqOf(waited[0] ?? "", "working")).toBeGreaterThan(seqOf(other, "landed"));
		// Trunk moved once: the second Intent's work was already there.
		expect(events.filter((event) => event.t === "trunk.advanced").map((event) => event.t === "trunk.advanced" && event.byIntent)).toEqual([other]);

		const instances = await introspector.get();
		await Promise.all(instances.map((instance) => instance.waitForStatus("complete")));
		await gateIdle();
	}, 90_000);
});

describe("dispatchTasks when a fork cannot be made", () => {
	it("starts the tasks it can, and says which it could not", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const real = getRepoStore(env);
		let forks = 0;
		// The second fork fails, as Artifacts sometimes does under load even after retries.
		const flaky = new Proxy(real, {
			get(target, property, receiver) {
				if (property === "fork") {
					return async (source: string, name: string) => {
						if (++forks === 2) {
							throw new Error("An internal error occurred.");
						}
						return target.fork(source, name);
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const error = await dispatchTasks(env, ["t10-invoice-numbering", "t06-discount-stacking"], undefined, flaky).then(
			() => null,
			(thrown: unknown) => thrown,
		);
		expect(error).toBeInstanceOf(DispatchFailed);
		const failure = error as DispatchFailed;
		expect(failure.started).toHaveLength(1);
		expect(failure.failed).toHaveLength(1);
		expect(failure.failed[0]?.error).toBe("An internal error occurred.");
		expect(failure.message).toMatch(/^could not start 1 of 2 tasks: t\d\d-[a-z-]+ \(An internal error occurred\.\)$/);
		// The one that started is a real Intent and runs to the end.
		const done = await waitForStatus(failure.started[0] ?? "", ["landed", "failed", "stale"]);
		expect(done.status).toBe("landed");
		expect([done.taskId, failure.failed[0]?.taskId].sort()).toEqual(["t06-discount-stacking", "t10-invoice-numbering"]);
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
		await gateIdle();
	}, 60_000);
});

describe("POST /api/admin/llm", () => {
	it("chooses the model provider at run time, refuses one that cannot work, and can be put back", async () => {
		const unknown = await post("/api/admin/llm", { provider: "nope" });
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toMatchObject({ error: expect.stringContaining('LLM="nope" is not a known provider') });
		const bad = await post("/api/admin/llm", { provider: 7 });
		expect(bad.status).toBe(400);
		await bad.text();
		const noToken = await post("/api/admin/llm", { provider: "scripted" }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();
		expect(await hub(env).llm()).toBeNull();

		expect(await (await post("/api/admin/llm", { provider: "scripted" })).json()).toEqual({ ok: true, llm: { provider: "scripted" } });
		expect(await hub(env).llm()).toEqual({ provider: "scripted" });
		// It is configuration, so a reset of the event log leaves it alone.
		await hub(env, "llm-test").setLlm({ provider: "google", model: "m" });
		await hub(env, "llm-test").reset();
		expect(await hub(env, "llm-test").llm()).toEqual({ provider: "google", model: "m" });

		expect(await (await post("/api/admin/llm", { provider: null })).json()).toEqual({ ok: true, llm: { provider: "scripted" } });
		expect(await hub(env).llm()).toBeNull();
	});
});

describe("POST /api/human/:id", () => {
	it("validates the choice and publishes human.resolved", async () => {
		const bad = await post("/api/human/i00000001", { choice: "Maybe" });
		expect(bad.status).toBe(400);
		await bad.text();
		const noToken = await post("/api/human/i00000001", { choice: "Wait" }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();

		// The log keeps what is said about Intents it has seen created, so this one is made known to it first.
		await hub(env).publish({ t: "intent.created", intent: { id: "i00000001", kind: "agent", taskId: "t05-tax-rounding", goal: "g", status: "quarantined", claims: [], premises: [], why: [], baseCommit: "c0", headCommit: null, rederiveAttempts: 0 } });
		const response = await post("/api/human/i00000001", { choice: "Split" });
		expect(await response.json()).toEqual({ ok: true, id: "i00000001", choice: "Split", woken: 0, status: null });
		expect((await hub(env).since(0, 5000)).at(-1)).toMatchObject({ t: "human.resolved", id: "i00000001", choice: "Split" });

		// A choice about an Intent the log never saw (one from before a reset, say) is not written into it.
		const before = (await hub(env).since(0, 5000)).length;
		await (await post("/api/human/i00000002", { choice: "Wait" })).text();
		expect((await hub(env).since(0, 5000)).length).toBe(before);
	});
});

describe("POST /api/admin/reset-demo", () => {
	it("deletes Intent forks, makes a fresh trunk under a new name, and clears the log and the ledger", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const store = getRepoStore(env);
		const { intents: ids } = (await (await post("/api/dispatch", { taskIds: ["t12-password-policy"] })).json()) as { intents: string[] };
		expect((await waitForStatus(ids[0] ?? "", ["landed", "failed", "stale"])).status).toBe("landed");
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
		await gateIdle();
		const oldTrunk = await currentTrunk(env);
		expect((await store.list()).some(isIntentRepo)).toBe(true);

		const response = await post("/api/admin/reset-demo", {});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; trunk: string; head: string; forksDeleted: number; previousTrunk: string };
		expect(body).toMatchObject({ ok: true, previousTrunk: oldTrunk });
		expect(body.trunk).toMatch(/^trunk-[0-9a-z]+$/);
		expect(body.forksDeleted).toBeGreaterThanOrEqual(1);

		expect(await currentTrunk(env)).toBe(body.trunk);
		expect((await store.list()).filter(isIntentRepo)).toEqual([]);
		expect(await store.readFile(body.trunk, "main", "src/auth/session.ts")).toContain("throw new SessionExpiredError");
		expect(await get<TaskDef[]>("/api/tasks")).toHaveLength(12);

		// A clean slate: one metrics event, nothing in the registry or the ledger.
		expect((await hub(env).since(0)).map((event) => event.t)).toEqual(["metrics"]);
		expect(await get<RegistryRow[]>("/api/intents")).toEqual([]);
		expect(await get<LedgerSnapshot>("/api/ledger")).toEqual({ claims: [], readers: [] });
		expect(await get<Metrics>("/api/metrics")).toMatchObject({ agentsActive: 0, intentsLanded: 0, forksCreated: 0, pushes: 0 });
		expect(await get<LandingStatus>("/api/gate")).toMatchObject({ queue: [], busy: false, stale: [], rederiving: [] });

		// And it can be dispatched against straight away.
		const { intents: fresh } = (await (await post("/api/dispatch", { taskIds: ["t12-password-policy"] })).json()) as { intents: string[] };
		expect((await waitForStatus(fresh[0] ?? "", ["landed", "failed", "stale"])).status).toBe("landed");
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
		await gateIdle();
		// It landed on the fresh trunk, not the old one.
		expect(await store.readFile(body.trunk, "main", "tests/password-digit.test.ts")).not.toBeNull();
	}, 90_000);
});

describe("recoverMemoryStore: the in-memory repos were lost but Durable Object storage was not", () => {
	it("leaves a consistent state alone", async () => {
		await gateIdle();
		await resetDemo(env);
		expect(await recoverMemoryStore(env)).toBe(false);
	});

	it("starts again when the hub names a trunk that no longer exists", async () => {
		await resetDemo(env);
		// What a dev-server restart leaves behind: the name of a trunk copy from before it.
		await hub(env).setTrunk("trunk-gone");
		expect(await recoverMemoryStore(env)).toBe(true);

		const trunk = await currentTrunk(env);
		expect(trunk).not.toBe("trunk-gone");
		expect(await getRepoStore(env).list()).toContain(trunk);
		expect(await get<TaskDef[]>("/api/tasks")).toHaveLength(12);
		expect(await recoverMemoryStore(env)).toBe(false);
	});

	it("starts again when the log shows Intents but none of their forks exist", async () => {
		await resetDemo(env);
		await hub(env).publish({
			t: "intent.created",
			intent: { id: "i0000lost", kind: "agent", taskId: "t12-password-policy", goal: "g", status: "working", claims: [], premises: [], why: [], baseCommit: "c0", headCommit: null, rederiveAttempts: 0 },
		});
		expect(await get<RegistryRow[]>("/api/intents")).toHaveLength(1);
		expect(await recoverMemoryStore(env)).toBe(true);
		expect(await get<RegistryRow[]>("/api/intents")).toEqual([]);
	});

	it("does nothing with real Artifacts", async () => {
		await hub(env).setTrunk("trunk-gone");
		expect(await recoverMemoryStore({ ...env, REPO_STORE: "artifacts" })).toBe(false);
		expect(await currentTrunk(env)).toBe("trunk-gone");
		// Put it right for whatever runs next.
		expect(await recoverMemoryStore(env)).toBe(true);
	});
});

