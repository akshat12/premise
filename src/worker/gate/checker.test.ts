import { describe, expect, it } from "vitest";
import type { Claim, Premise } from "../../shared/types";
import { surface } from "../surface";
import { demoFiles, demoWith } from "../testing/demo";
import { changedFiles, checkPush, derivedPremises, mergeClaims, upgradeClaims } from "./checker";

const base = demoFiles();
const body = (symbol: string): Claim => ({ symbol, mode: "body" });
const iface = (symbol: string): Claim => ({ symbol, mode: "interface" });
const LOGIN = "src/auth/login.ts#handleLogin";
const VERIFY = "src/auth/session.ts#verifySession";

describe("changedFiles", () => {
	it("lists edits, additions and deletions, and ignores .intent/", () => {
		const head = { ...base, "src/new.ts": "export const n = 1;\n", ".intent/intent.json": "{}", "src/auth/login.ts": `${base["src/auth/login.ts"]}\n// edited\n` };
		delete (head as Record<string, string>)["src/util/strings.ts"];
		expect(changedFiles(base, head)).toEqual(["src/auth/login.ts", "src/new.ts", "src/util/strings.ts"]);
		expect(changedFiles(base, { ...base, ".intent/intent.json": "{}" })).toEqual([]);
	});
});

describe("checkPush", () => {
	it("an edit that stays within its claims is not out of claim", () => {
		const result = checkPush(base, demoWith("t02"), [body(LOGIN)]);
		expect(result.touched).toEqual([{ symbol: LOGIN, part: "body" }]);
		expect(result.outOfClaim).toEqual([]);
	});

	it("the t02 reference patch derives premises on verifySession and SessionExpiredError", () => {
		const { derived } = checkPush(base, demoWith("t02"), [body(LOGIN)]);
		// The changed lines are in the catch branch, and the new test exercises the whole function.
		expect(derived).toContain(VERIFY);
		expect(derived).toContain("src/auth/session.ts#SessionExpiredError");
		expect(derived).toContain("src/auth/audit.ts#record");
		expect(derived).toContain("src/api/responses.ts#expired");
		// Its own symbol is not something it relies on.
		expect(derived).not.toContain(LOGIN);
		// Test helpers and Premise's own files have no type surface, so they are never premises.
		expect(derived.some((symbol) => symbol.startsWith("tests/") || symbol.startsWith("premise/"))).toBe(false);
	});

	it("editing a symbol in another file is out of claim", () => {
		const head = { ...demoWith("t02"), "src/auth/audit.ts": (base["src/auth/audit.ts"] ?? "").replace("log.entries.push(entry);", "log.entries.unshift(entry);") };
		const result = checkPush(base, head, [body(LOGIN)]);
		expect(result.touched.map((touch) => touch.symbol)).toEqual(["src/auth/audit.ts#record", LOGIN]);
		expect(result.outOfClaim).toEqual(["src/auth/audit.ts#record"]);
		expect(upgradeClaims(result)).toEqual([body("src/auth/audit.ts#record")]);
	});

	it("a signature change under a body claim is out of claim", () => {
		const head = { ...base, "src/auth/login.ts": (base["src/auth/login.ts"] ?? "").replace("export function handleLogin(token: string | undefined, deps: LoginDeps): ApiResponse {", "export function handleLogin(token: string | null | undefined, deps: LoginDeps): ApiResponse {") };
		const underBody = checkPush(base, head, [body(LOGIN)]);
		expect(underBody.touched).toEqual([{ symbol: LOGIN, part: "interface" }]);
		expect(underBody.outOfClaim).toEqual([LOGIN]);
		expect(upgradeClaims(underBody)).toEqual([iface(LOGIN)]);
		// The same edit under an interface claim is fine.
		expect(checkPush(base, head, [iface(LOGIN)]).outOfClaim).toEqual([]);
	});

	it("a new export needs a claim too", () => {
		const result = checkPush(base, demoWith("t07"), [iface("src/users/roles.ts#canAccess")]);
		expect(result.outOfClaim).toEqual(["src/users/roles.ts#RESOURCE_MINIMUM", "src/users/roles.ts#Resource"]);
	});

	it("ignores changes to .intent/ and to test files when looking for touched symbols", () => {
		const head = { ...base, ".intent/intent.json": '{"id":"i1"}', "tests/extra.test.ts": 'import { taxFor } from "../src/billing/tax.js";\nexport const tests = { t: () => { taxFor(1, 1); } };\n' };
		const result = checkPush(base, head, []);
		expect(result.touched).toEqual([]);
		expect(result.outOfClaim).toEqual([]);
		// The new test still tells us what the Intent leans on.
		expect(result.derived).toEqual(["src/billing/tax.ts#taxFor"]);
	});

	it("reports nothing for identical snapshots", () => {
		expect(checkPush(base, { ...base }, [body(LOGIN)])).toEqual({ touched: [], outOfClaim: [], derived: [] });
	});

	it("only looks at the lines that changed in an edited file", () => {
		// t04 changes withSessionHeaders; fromError in the same file refers to RateLimitedError, which it did not touch.
		const { derived } = checkPush(base, demoWith("t04"), [body("src/api/responses.ts#withSessionHeaders")]);
		expect(derived).toContain("src/auth/session.ts#sessionTtl");
		expect(derived).not.toContain("src/util/errors.ts#RateLimitedError");
	});
});

describe("mergeClaims and derivedPremises", () => {
	it("mergeClaims adds new symbols and strengthens body to interface, never the reverse", () => {
		expect(mergeClaims([body("a#x"), iface("a#y")], [iface("a#x"), body("a#y"), body("a#z")])).toEqual([iface("a#x"), iface("a#y"), body("a#z")]);
	});

	it("derivedPremises carries the base surface hash and skips what was already observed", () => {
		const baseSurface = surface(base).map;
		const existing: Premise[] = [{ symbol: VERIFY, source: "observed", surfaceHash: "h", state: "holding" }];
		const premises = derivedPremises([VERIFY, "src/auth/audit.ts#record", "src/gone.ts#nope"], baseSurface, existing);
		expect(premises).toEqual([{ symbol: "src/auth/audit.ts#record", source: "derived", surfaceHash: baseSurface.get("src/auth/audit.ts#record")?.hash, state: "holding" }]);
	});
});
