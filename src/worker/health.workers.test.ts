import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
