import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getRepoStore } from "./ports";

describe("GET /api/health", () => {
	it("answers from the Worker", async () => {
		const response = await exports.default.fetch("http://premise.test/api/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, store: "memory", llm: "scripted" });
	});

	it("returns 404 for unknown API routes", async () => {
		const response = await exports.default.fetch("http://premise.test/api/nope");
		expect(response.status).toBe(404);
	});
});

describe("admin routes", () => {
	it("reject requests without the admin token", async () => {
		const response = await exports.default.fetch("http://premise.test/api/admin/smoke", { method: "POST" });
		expect(response.status).toBe(401);
	});

	it("reject a wrong admin token", async () => {
		const response = await exports.default.fetch("http://premise.test/api/admin/smoke", {
			method: "POST",
			headers: { "x-admin-token": "definitely-not-the-token" },
		});
		expect(response.status).toBe(401);
	});
});

describe("memory trunk", () => {
	it("is seeded from the bundled demo repo", async () => {
		const store = getRepoStore(env);
		expect(await store.readFile(env.TRUNK_REPO, "main", "src/auth/session.ts")).toContain("export function verifySession(");
		expect((await store.listFiles(env.TRUNK_REPO, "main")).length).toBeGreaterThan(60);
		expect(await store.head(env.TRUNK_REPO)).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("admin routes with the token", () => {
	const admin = { method: "POST", headers: { "x-admin-token": "test-admin-token" } };

	it("import-trunk reports the bundled trunk in memory mode", async () => {
		const response = await exports.default.fetch("http://premise.test/api/admin/import-trunk", admin);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; store: string; repo: string; status: string; head: string; files: number };
		expect(body).toMatchObject({ ok: true, store: "memory", repo: "trunk", status: "ready" });
		expect(body.head).toMatch(/^[0-9a-f]{40}$/);
		expect(body.files).toBeGreaterThan(60);
	});

	// The isolate that runs trunk's tests has a wall-clock budget, and the whole suite runs many isolates at once,
	// so under that load this can time out. It is tried again before it counts as a failure.
	it("analyze typechecks trunk with the compiler running in the Worker", { retry: 2 }, async () => {
		const response = await exports.default.fetch("http://premise.test/api/admin/analyze", admin);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; errors: string[]; symbols: number; verifySession: { decl: string } | null; runner: { loadError: string | null; testsPassed: number; testsFailed: unknown[]; assertions: { id: string; ok: boolean }[] } };
		expect(body.runner).toMatchObject({ loadError: null, testsPassed: 8, testsFailed: [], assertions: [{ id: "a-session-throws", ok: true }] });
		expect(body.errors).toEqual([]);
		expect(body.ok).toBe(true);
		expect(body.symbols).toBeGreaterThanOrEqual(200);
		expect(body.verifySession?.decl).toContain("Session | null");
	});

	it("events/fake publishes a valid body and rejects an unknown type", async () => {
		const good = await exports.default.fetch("http://premise.test/api/admin/events/fake", { ...admin, body: JSON.stringify({ t: "demo.marker", label: "from a test" }) });
		expect(good.status).toBe(200);
		expect(await good.json()).toMatchObject({ t: "demo.marker", label: "from a test" });
		const bad = await exports.default.fetch("http://premise.test/api/admin/events/fake", { ...admin, body: JSON.stringify({ t: "nope" }) });
		expect(bad.status).toBe(400);
		await bad.text();
	});

	it("unknown admin routes are 404 and GET is 405", async () => {
		const missing = await exports.default.fetch("http://premise.test/api/admin/nope", admin);
		expect(missing.status).toBe(404);
		await missing.text();
		const get = await exports.default.fetch("http://premise.test/api/admin/smoke", { headers: admin.headers });
		expect(get.status).toBe(405);
		await get.text();
	});
});
