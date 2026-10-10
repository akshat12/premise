import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../shared/events";
import type { Intent, Metrics, TaskDef } from "../shared/types";
import { isIntentRepo, priorityFor } from "./dispatch";
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

	it("dispatches two tasks: two Intents, two forks, two workflows, and both reach the gate's queue", async () => {
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

		const [role, currency] = await Promise.all(ids.map((id) => waitForStatus(id, ["queued"])));
		expect(role).toMatchObject({ taskId: "t07-role-check", kind: "agent", status: "queued", baseCommit: trunkHead, repo: ids[0] });
		expect(currency).toMatchObject({ taskId: "t09-currency-format", status: "queued" });
		expect(role?.acceptance.map((check) => check.id)).toEqual(["t07-ac1", "t07-ac2", "t07-ac3"]);
		expect(await store.head(ids[0] ?? "")).toBe(role?.headCommit);
		expect(await store.readFile(ids[0] ?? "", "main", "src/users/roles.ts")).toContain("export function canAccess(");
		// Trunk did not move: only the gate lands work.
		expect(await store.head(trunk)).toBe(trunkHead);

		// The events, in order, for one of the Intents.
		const events = (await hub(env).since(before, 5000)) as PremiseEvent[];
		const mine = events.filter((event) => ("id" in event && event.id === ids[0]) || (event.t === "intent.created" && event.intent.id === ids[0]) || (event.t === "artifacts" && event.repo === ids[0]));
		expect(mine.map((event) => event.t).filter((t, index, all) => t !== all[index - 1])).toEqual(["artifacts", "intent.created", "premise.recorded", "intent.why", "intent.status", "claim.decision", "intent.status", "artifacts", "intent.status", "push.checked", "intent.status"]);
		expect(mine[0]).toMatchObject({ t: "artifacts", type: "forked", detail: { source: trunk } });
		expect(events.filter((event) => event.t === "metrics").length).toBeGreaterThanOrEqual(1);

		// The registry, the Intent API and the ledger all show them.
		const registry = await get<RegistryRow[]>("/api/intents");
		expect(registry.filter((row) => ids.includes(row.id)).map((row) => [row.taskId, row.status, row.kind])).toEqual([["t07-role-check", "queued", "agent"], ["t09-currency-format", "queued", "agent"]]);
		expect(await get<Intent>(`/api/intents/${ids[0]}`)).toMatchObject({ id: ids[0], status: "queued" });
		const ledger = await get<LedgerSnapshot>("/api/ledger");
		expect(ledger.claims.filter((claim) => ids.includes(claim.intentId)).map((claim) => claim.symbol).sort()).toEqual(["src/billing/currency.ts#formatMoney", "src/users/roles.ts#RESOURCE_MINIMUM", "src/users/roles.ts#Resource", "src/users/roles.ts#canAccess"]);
		expect(ledger.readers.some((reader) => reader.intentId === ids[0] && reader.symbol === "src/users/roles.ts#isAtLeast")).toBe(true);

		const metrics = await get<Metrics>("/api/metrics");
		expect(metrics.forksCreated).toBeGreaterThanOrEqual(2);
		expect(metrics.pushes).toBeGreaterThanOrEqual(2);
		expect(metrics.agentsActive).toBeGreaterThanOrEqual(2);

		for (const id of ids) {
			await intentStub(env, id).act({ a: "fail" }, "test cleanup");
		}
	}, 60_000);

	it("wakes a waiting agent when the Intent it waits on fails or lands", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const first = ((await (await post("/api/dispatch", { taskIds: ["t08-profile-validation"] })).json()) as { intents: string[] }).intents[0] ?? "";
		await waitForStatus(first, ["queued"]);

		// The same task again: it wants the same symbols, so the ledger makes it wait.
		const second = ((await (await post("/api/dispatch", { taskIds: ["t08-profile-validation"] })).json()) as { intents: string[] }).intents[0] ?? "";
		expect((await waitForStatus(second, ["waiting"])).status).toBe("waiting");

		// The first Intent goes away, which releases its claims and wakes the second.
		await intentStub(env, first).act({ a: "fail" }, "abandoned");
		expect((await waitForStatus(second, ["queued", "failed"], 30_000)).status).toBe("queued");

		const instances = await introspector.get();
		await Promise.all(instances.map((instance) => instance.waitForStatus("complete")));
		await intentStub(env, second).act({ a: "fail" }, "test cleanup");
	}, 90_000);
});

describe("POST /api/human/:id", () => {
	it("validates the choice and publishes human.resolved", async () => {
		const bad = await post("/api/human/i00000001", { choice: "Maybe" });
		expect(bad.status).toBe(400);
		await bad.text();
		const noToken = await post("/api/human/i00000001", { choice: "Wait" }, {});
		expect(noToken.status).toBe(401);
		await noToken.text();

		const response = await post("/api/human/i00000001", { choice: "Split" });
		expect(await response.json()).toEqual({ ok: true, id: "i00000001", choice: "Split", woken: 0, status: null });
		expect((await hub(env).since(0, 5000)).at(-1)).toMatchObject({ t: "human.resolved", id: "i00000001", choice: "Split" });
	});
});

describe("POST /api/admin/reset-demo", () => {
	it("deletes Intent forks, makes a fresh trunk under a new name, and clears the log and the ledger", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const store = getRepoStore(env);
		const { intents: ids } = (await (await post("/api/dispatch", { taskIds: ["t12-password-policy"] })).json()) as { intents: string[] };
		await waitForStatus(ids[0] ?? "", ["queued"]);
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
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
		expect(await get<Metrics>("/api/metrics")).toMatchObject({ agentsActive: 0, forksCreated: 0, pushes: 0 });

		// And it can be dispatched against straight away.
		const { intents: fresh } = (await (await post("/api/dispatch", { taskIds: ["t12-password-policy"] })).json()) as { intents: string[] };
		expect((await waitForStatus(fresh[0] ?? "", ["queued"])).status).toBe("queued");
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete")));
		await intentStub(env, fresh[0] ?? "").act({ a: "fail" }, "test cleanup");
	}, 90_000);
});
