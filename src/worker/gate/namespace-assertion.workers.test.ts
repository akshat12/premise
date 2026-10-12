// An agent that asserts about a function through a namespace of its import (`session.verifySession(...)`)
// and then changes that function must have the assertion withdrawn, or its own change breaks its own
// premise and it can never submit. Written by an independent verifier (2026-10-12) and kept.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callTool, createToolContext } from "../agent/tools";
import { seededStore, startIntent } from "../testing/agent";
import { referencePatch } from "../testing/demo";

const VERIFY = "src/auth/session.ts#verifySession";

describe("C5b: an agent that asserted about verifySession through a namespace call, then changes verifySession (task t01)", () => {
	it("SAFE: after writing the reference solution its own checks pass and it can submit", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t01-null-expired");
		const ctx = createToolContext(env, store, started.api, started.id);
		const call = (name: string, input: Record<string, unknown> = {}) => callTool(ctx, name, input);
		const recorded = await call("assert_premise", { description: "verifySession throws on expiry", code: 'import * as session from "src/auth/session.ts";\nimport * as stores from "src/store/memory-store.ts";\nconst store = stores.createMemorySessionStore([{ id: "s1", userId: "u1", expiresAt: 0 }]);\nassert.throws(() => session.verifySession("s1", store, () => 10), session.SessionExpiredError);' });
		const declared = await call("declare_changes", { claims: [{ symbol: VERIFY, mode: "body" }], why: ["change how expiry is reported"] });
		ctx.phase = "work";
		for (const [path, content] of Object.entries(referencePatch("t01"))) {
			if (content !== null) await call("write_file", { path, content });
		}
		const checks = await call("run_checks");
		const submit = await call("submit", { message: "verifySession returns null on expiry" });
		expect(checks.isError).not.toBe(true);
		expect(submit).toMatchObject({ signal: "submit" });
		await started.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
	}, 60_000);
});
