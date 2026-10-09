import { describe, expect, it } from "vitest";
import { isValidRepoName, moduleShard, newIntentId, parseSymbolId, symbolId } from "./ids";

describe("newIntentId", () => {
	it("is 'i' plus 8 lowercase base36 chars", () => {
		expect(newIntentId()).toMatch(/^i[0-9a-z]{8}$/);
	});

	it("produces valid Artifacts repo names (1000 samples)", () => {
		const ids = Array.from({ length: 1000 }, () => newIntentId());
		for (const id of ids) {
			expect(id).toMatch(/^i[0-9a-z]{8}$/);
			expect(isValidRepoName(id)).toBe(true);
		}
		// 36^8 possibilities: any collision in 1000 draws means the generator is broken.
		expect(new Set(ids).size).toBe(1000);
	});
});

describe("symbolId / parseSymbolId", () => {
	it("joins path and export name with '#'", () => {
		expect(symbolId("src/auth/session.ts", "verifySession")).toBe("src/auth/session.ts#verifySession");
	});

	it("round-trips", () => {
		const cases: [string, string][] = [
			["src/auth/session.ts", "verifySession"],
			["src/index.ts", "default"],
			["a.ts", "A"],
			["src/billing/deep/nested/tax.ts", "taxFor"],
		];
		for (const [path, name] of cases) {
			expect(parseSymbolId(symbolId(path, name))).toEqual({ path, name });
		}
	});

	it("rejects parts that cannot round-trip", () => {
		expect(() => symbolId("", "x")).toThrow();
		expect(() => symbolId("src/a.ts", "")).toThrow();
		expect(() => symbolId("src/a#b.ts", "x")).toThrow();
	});

	it("throws on malformed ids", () => {
		for (const bad of ["", "src/auth/session.ts", "#verifySession", "src/a.ts#", "src/a.ts#b#c"]) {
			expect(() => parseSymbolId(bad)).toThrow(/malformed SymbolId/);
		}
	});
});

describe("moduleShard", () => {
	it("returns the first two path segments", () => {
		expect(moduleShard("src/auth/session.ts#x")).toBe("src/auth");
		expect(moduleShard("src/billing/invoice.ts#computeTotal")).toBe("src/billing");
	});

	it("ignores deeper directories", () => {
		expect(moduleShard("src/billing/deep/nested/tax.ts#taxFor")).toBe("src/billing");
	});

	it("returns 'src' for a file directly under src/", () => {
		expect(moduleShard("src/index.ts#main")).toBe("src");
	});

	it("handles files outside src/", () => {
		expect(moduleShard("tests/auth.test.ts#tests")).toBe("tests");
		expect(moduleShard("premise/assert.ts#eq")).toBe("premise");
		expect(moduleShard("root.ts#x")).toBe(".");
	});

	it("puts two symbols of one file in the same shard", () => {
		expect(moduleShard("src/auth/session.ts#a")).toBe(moduleShard("src/auth/session.ts#b"));
	});

	it("throws on a malformed symbol", () => {
		expect(() => moduleShard("src/auth/session.ts")).toThrow();
	});
});

describe("isValidRepoName", () => {
	it("accepts letters, digits, dot, underscore and dash", () => {
		for (const ok of ["trunk", "i3k9x0a2q", "0abc", "A.b_c-d", "x"]) {
			expect(isValidRepoName(ok)).toBe(true);
		}
	});

	it("rejects a bad first character, bad characters and the empty string", () => {
		for (const bad of ["", "-abc", ".abc", "_abc", "a/b", "a b", "a#b", "é"]) {
			expect(isValidRepoName(bad)).toBe(false);
		}
	});

	it("enforces the 63-character limit", () => {
		expect(isValidRepoName("a".repeat(63))).toBe(true);
		expect(isValidRepoName("a".repeat(64))).toBe(false);
	});
});
