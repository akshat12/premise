import { describe, expect, it } from "vitest";
import { demoFiles, demoWith } from "../testing/demo";
import { analyze, diffSurface, surface, typecheck } from "./index";

// The same code as surface.test.ts, but running inside workerd. This is the proof that the
// TypeScript compiler works in the Worker, not only in Node.
describe("surface inside the Workers runtime", () => {
	it("is running in workerd", () => {
		expect(navigator.userAgent).toBe("Cloudflare-Workers");
	});

	it("typechecks and computes surfaces for the demo repo", () => {
		const result = analyze(demoFiles());
		expect(result.typecheck.errors).toEqual([]);
		expect(result.surface.size).toBeGreaterThanOrEqual(200);
		expect(result.surface.get("src/auth/session.ts#verifySession")?.decl).toContain("Session | null");
	});

	it("reports a type error", () => {
		const result = typecheck({ "src/a.ts": "export const n: number = 'text';\n" });
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("src/a.ts:1:");
	});

	it("sees no surface change from the planted t01 patch", () => {
		expect(diffSurface(surface(demoFiles()).map, surface(demoWith("t01")).map)).toEqual({ changed: [], added: [], removed: [] });
	});
});
