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
