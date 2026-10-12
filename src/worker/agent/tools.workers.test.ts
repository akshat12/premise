import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { surface } from "../surface";
import { seededStore, startIntent } from "../testing/agent";
import type { Assertion, Premise } from "../../shared/types";
import { demoFiles, demoWith } from "../testing/demo";
import { assertionSymbol, callTool, commitChanges, createToolContext, holding, isHidden, parseDeclaration, TOOLS, ToolError, unanswered } from "./tools";

async function setup(taskId = "t02-audit-expired") {
	const store = seededStore();
	const started = await startIntent(env, store, taskId);
	const ctx = createToolContext(env, store, started.api, started.id);
	const call = (name: string, input: Record<string, unknown> = {}) => callTool(ctx, name, input);
	return { ...started, store, ctx, call };
}

const LOGIN = "src/auth/login.ts";
const VERIFY = "src/auth/session.ts#verifySession";

describe("tool definitions", () => {
	it("are the nine tools, each with an object schema", () => {
		expect(TOOLS.map((tool) => tool.name)).toEqual(["list_files", "read_file", "search_symbols", "read_symbol", "assert_premise", "declare_changes", "write_file", "run_checks", "submit"]);
		for (const tool of TOOLS) {
			expect(tool.input_schema).toMatchObject({ type: "object" });
			expect(tool.description.length).toBeGreaterThan(20);
		}
	});

	it("hide Premise's own files", () => {
		expect(["premise/tasks.json", "premise/reference/t01.patch.ts", "premise/hidden-tests/x.test.ts", ".intent/intent.json", "tests/hidden/x.ts"].every(isHidden)).toBe(true);
		expect(["src/auth/login.ts", "tests/login.test.ts", "premise/assert.ts", "package.json"].some(isHidden)).toBe(false);
	});
});

describe("list_files", () => {
	it("lists the repo without hidden files", async () => {
		const { call } = await setup();
		const paths = (await call("list_files")).text.split("\n");
		expect(paths).toContain("src/auth/session.ts");
		expect(paths).toContain("tests/login.test.ts");
		expect(paths).toContain("premise/assert.ts");
		expect(paths.some((path) => path.startsWith("premise/") && path !== "premise/assert.ts")).toBe(false);
	});

	it("filters by directory", async () => {
		const { call } = await setup();
		const paths = (await call("list_files", { dir: "src/auth" })).text.split("\n");
		expect(paths).toHaveLength(7);
		expect(paths.every((path) => path.startsWith("src/auth/"))).toBe(true);
		expect((await call("list_files", { dir: "nowhere" })).text).toBe('No files under "nowhere/".');
	});
});

describe("read_file", () => {
	it("returns the file and records every exported symbol in it as an observed premise", async () => {
		const { call, api } = await setup();
		const result = await call("read_file", { path: "src/auth/session.ts" });
		expect(result.isError).toBeUndefined();
		expect(result.text).toBe(demoFiles()["src/auth/session.ts"]);

		const expected = surface(demoFiles()).map;
		const premises = (await api.get()).premises;
		expect(premises.map((premise) => premise.symbol.split("#")[1]).sort()).toEqual(["DEFAULT_SESSION_TTL_MS", "Session", "SessionExpiredError", "SessionStore", "createSession", "extendSession", "isExpired", "revokeSession", "sessionTtl", "verifySession"]);
		for (const premise of premises) {
			expect(premise).toMatchObject({ source: "observed", state: "holding", surfaceHash: expected.get(premise.symbol)?.hash });
		}
	});

	it("does not record the same file twice, and records nothing for tests", async () => {
		const { call, api } = await setup();
		await call("read_file", { path: LOGIN });
		const once = (await api.get()).premises.length;
		await call("read_file", { path: LOGIN });
		await call("read_file", { path: "tests/login.test.ts" });
		expect((await api.get()).premises).toHaveLength(once);
	});

	it("refuses hidden and missing files", async () => {
		const { call } = await setup();
		expect(await call("read_file", { path: "premise/tasks.json" })).toMatchObject({ isError: true, text: expect.stringContaining("No such file") });
		expect(await call("read_file", { path: "premise/reference/t02.patch.ts" })).toMatchObject({ isError: true });
		expect(await call("read_file", { path: "src/nope.ts" })).toMatchObject({ isError: true });
		expect(await call("read_file", { path: "../outside.ts" })).toMatchObject({ isError: true });
		expect(await call("read_file", {})).toMatchObject({ isError: true });
	});
});

describe("search_symbols and read_symbol", () => {
	it("finds symbols by name or path and records them", async () => {
		const { call, api } = await setup();
		const result = await call("search_symbols", { query: "verifysession" });
		expect(result.text).toContain(VERIFY);
		expect(result.text).toContain("export declare function verifySession(");
		// The search is by substring and ignores case, so it also finds the VerifySession type the guard declares.
		expect((await api.get()).premises.map((premise) => premise.symbol)).toEqual(["src/auth/rate-limit.ts#VerifySession", VERIFY]);
		expect((await call("search_symbols", { query: "zzz-nothing" })).text).toContain("No exported symbol matches");
	});

	it("returns at most 30 results", async () => {
		const { call } = await setup();
		const lines = (await call("search_symbols", { query: "src/" })).text.split("\n").filter((line) => !line.startsWith("    "));
		expect(lines).toHaveLength(30);
	});

	it("reads one symbol's source", async () => {
		const { call, api } = await setup();
		const result = await call("read_symbol", { symbol: VERIFY });
		expect(result.text.startsWith("/** Returns null when no token is given.")).toBe(true);
		expect(result.text.trimEnd().endsWith("}")).toBe(true);
		expect(result.text).not.toContain("createSession");
		expect((await api.get()).premises.map((premise) => premise.symbol)).toEqual([VERIFY]);
		expect(await call("read_symbol", { symbol: "src/auth/session.ts#nope" })).toMatchObject({ isError: true });
		expect(await call("read_symbol", { symbol: "not a symbol" })).toMatchObject({ isError: true });
	});
});

describe("assert_premise", () => {
	it("adopts a pre-written assertion from the repo", async () => {
		const { call, api } = await setup();
		const result = await call("assert_premise", { adopt: "a-session-throws" });
		expect(result).toEqual({ text: `Recorded premise a-session-throws on ${VERIFY}: verifySession throws SessionExpiredError on expired tokens` });
		const [premise] = (await api.get()).premises;
		expect(premise).toMatchObject({ symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: { id: "a-session-throws", imports: ["src/auth/session.ts", "src/store/memory-store.ts"] } });
	});

	it("records a custom assertion that holds, numbering it", async () => {
		const { call, api } = await setup();
		const first = await call("assert_premise", { description: "tax is rounded", code: "assert.eq(taxFor(1999, 2000), 400);", imports: ["./src/billing/tax.ts"] });
		const second = await call("assert_premise", { description: "empty roles deny", code: "assert.ok(!isAtLeast([], 'viewer'));", imports: ["src/users/roles"] });
		expect(first.text).toBe("Recorded premise a1 on src/billing/tax.ts#taxFor: tax is rounded");
		expect(second.text).toContain("Recorded premise a2 on src/users/roles.ts#isAtLeast");
		expect((await api.get()).premises.map((premise) => premise.assertion?.id)).toEqual(["a1", "a2"]);
	});

	it("accepts a check that carries its own import statements, reading them as the files to import", async () => {
		const { call, api } = await setup();
		const code = 'import { SessionExpiredError, verifySession } from "../auth/session.js";\nimport * as stores from "./src/store/memory-store.ts";\nconst store = stores.createMemorySessionStore([{ id: "s1", userId: "u1", expiresAt: 0 }]);\nassert.throws(() => verifySession("s1", store, () => 10), SessionExpiredError);';
		const result = await call("assert_premise", { description: "verifySession throws on expiry", code });
		expect(result).toEqual({ text: `Recorded premise a1 on ${VERIFY}: verifySession throws on expiry` });
		const assertion = (await api.get()).premises.find((premise) => premise.source === "asserted")?.assertion;
		expect(assertion?.imports).toEqual(["src/auth/session.ts", "src/store/memory-store.ts"]);
		expect(assertion?.code).not.toMatch(/^\s*import /m);
	});

	it("rejects an assertion that does not hold now, or cannot run", async () => {
		const { call, api } = await setup();
		expect(await call("assert_premise", { description: "wrong", code: "assert.eq(taxFor(100, 1000), 11);", imports: ["src/billing/tax.ts"] })).toMatchObject({ isError: true, text: expect.stringContaining("does not hold on the current code") });
		expect(await call("assert_premise", { description: "syntax", code: "assert.ok(;", imports: ["src/billing/tax.ts"] })).toMatchObject({ isError: true });
		expect(await call("assert_premise", { description: "missing file", code: "assert.ok(true);", imports: ["src/nope.ts"] })).toMatchObject({ isError: true, text: expect.stringContaining("does not exist") });
		// A check that calls nothing from the code would pass whatever the code does.
		expect(await call("assert_premise", { description: "vacuous", code: "assert.throws(() => { throw new SessionExpiredError('x'); }, SessionExpiredError);", imports: ["src/auth/session.ts"] })).toMatchObject({ isError: true, text: expect.stringContaining("calls no function from the files it imports") });
		expect(await call("assert_premise", { adopt: "a-no-such" })).toMatchObject({ isError: true, text: expect.stringContaining("Available: a-session-throws") });
		expect(await call("assert_premise", { description: "no code" })).toMatchObject({ isError: true });
		expect((await api.get()).premises).toEqual([]);
	});

	it("works out which symbol an assertion is about", () => {
		const files = demoFiles();
		const library = JSON.parse(files["premise/assertions.json"] ?? "[]");
		expect(assertionSymbol(library[0], files)).toBe(VERIFY);
		expect(assertionSymbol({ code: "assert.ok(DEFAULT_LOGIN_LIMIT.limit > 0);", imports: ["src/auth/rate-limit.ts"] }, files)).toBe("src/auth/rate-limit.ts#DEFAULT_LOGIN_LIMIT");
		expect(assertionSymbol({ code: "assert.ok(true);", imports: [] }, files)).toBeNull();
	});
});

describe("assert_premise: the symbol an agent names", () => {
	const tax = { description: "tax is rounded half up", code: "assert.eq(taxFor(105, 1000), 11);", imports: ["src/billing/tax.ts"] };

	it("must be a real symbol id; a malformed one is refused and nothing is recorded", async () => {
		const { call, api } = await setup();
		const refused = await call("assert_premise", { ...tax, symbol: "src/billing/tax.ts#taxFor#rounded" });
		expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("is not a symbol id") });
		expect(await call("assert_premise", { ...tax, symbol: "src/billing/tax.ts#noSuchThing" })).toMatchObject({ isError: true, text: expect.stringContaining("There is no exported symbol") });
		expect((await api.get()).premises.filter((premise) => premise.source === "asserted")).toEqual([]);
	});

	it("must be something the check uses: a check of one function cannot be filed under another", async () => {
		const { call, api } = await setup();
		const refused = await call("assert_premise", { ...tax, symbol: VERIFY });
		expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(`This check does not use ${VERIFY}`) });
		expect((await api.get()).premises.filter((premise) => premise.source === "asserted")).toEqual([]);
		const accepted = await call("assert_premise", { ...tax, symbol: "src/billing/tax.ts#taxFor" });
		expect(accepted.isError).toBeUndefined();
		expect(accepted.text).toContain("on src/billing/tax.ts#taxFor");
	});
});

describe("declare_changes", () => {
	const claims = [{ symbol: "src/auth/login.ts#handleLogin", mode: "body" }];

	it("stores the claims, why and rejected alternatives, and signals the driver", async () => {
		const { call, api } = await setup();
		const result = await call("declare_changes", { claims, why: ["one", "two", "three", "four"], rejected: ["rewrite verifySession"], no_behaviour: true });
		expect(result).toEqual({ text: "", signal: "claim" });
		expect(await api.get()).toMatchObject({ claims, why: ["one", "two", "three"], rejectedAlternatives: ["rewrite verifySession"] });
	});

	it("asks an agent that has asserted nothing what behaviour its plan relies on, before accepting the plan", async () => {
		const { call, api } = await setup();
		const asked = await call("declare_changes", { claims, why: ["one"] });
		expect(asked).toMatchObject({ isError: true, text: expect.stringContaining("does your plan depend on how any function you are NOT changing behaves") });
		expect(asked.signal).toBeUndefined();
		expect((await api.get()).claims).toEqual([]);
		// Having asserted something, it is not asked again.
		await call("assert_premise", { description: "tax is rounded half up", code: "assert.eq(taxFor(105, 1000), 11);", imports: ["src/billing/tax.ts"] });
		expect(await call("declare_changes", { claims, why: ["one"] })).toEqual({ text: "", signal: "claim" });
	});

	describe("in a re-derive that was stopped over a premise", () => {
		const library: Assertion[] = JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]");
		const threw: Premise = { symbol: VERIFY, source: "asserted", surfaceHash: null, assertion: library[0] as Assertion, state: "broken" };
		// Trunk after t01: verifySession returns null for an expired session.
		const redo = async () => {
			const store = seededStore(demoWith("t01"));
			const started = await startIntent(env, store, "t11-expired-rate-limit");
			const ctx = createToolContext(env, store, started.api, started.id);
			ctx.broken = [threw];
			return { ...started, call: (name: string, input: Record<string, unknown> = {}) => callTool(ctx, name, input) };
		};
		const guard = [{ symbol: "src/auth/rate-limit.ts#guardRequest", mode: "body" }];

		it("the plan is not accepted until it says what it relies on about that symbol now, and saying nothing is no answer", async () => {
			const { call, api } = await redo();
			const asked = await call("declare_changes", { claims: guard, why: ["one"], no_behaviour: true });
			expect(asked.isError).toBe(true);
			expect(asked.text).toContain(`what it relied on about ${VERIFY} stopped being true: "verifySession throws SessionExpiredError on expired tokens"`);
			expect(asked.text).toContain("On the code as it is now, that check fails:");
			expect(asked.text).toContain("match what it does now, not what it used to do");
			expect((await api.get()).claims).toEqual([]);

			// The old check cannot be taken again, because it is not true any more.
			expect(await call("assert_premise", { adopt: "a-session-throws" })).toMatchObject({ isError: true, text: expect.stringContaining("does not hold on the current code") });
			// An assertion about some other function does not answer for this one.
			await call("assert_premise", { description: "tax is rounded half up", code: "assert.eq(taxFor(105, 1000), 11);", imports: ["src/billing/tax.ts"] });
			expect((await call("declare_changes", { claims: guard, why: ["one"] })).isError).toBe(true);

			await call("assert_premise", {
				description: "verifySession returns null for an expired session",
				code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.eq(verifySession('s1', store, () => 10), null);",
				imports: ["src/auth/session.ts", "src/store/memory-store.ts"],
			});
			expect(await call("declare_changes", { claims: guard, why: ["one"] })).toEqual({ text: "", signal: "claim" });
		});

		it("the answer does not depend on the order the assertion lists its imports in", async () => {
			const { call } = await redo();
			// Filed under createMemorySessionStore, the first function it calls in import order; it is still about verifySession.
			const recorded = await call("assert_premise", {
				description: "verifySession returns null for an expired session",
				code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.eq(verifySession('s1', store, () => 10), null);",
				imports: ["src/store/memory-store.ts", "src/auth/session.ts"],
			});
			expect(recorded.text).toContain("src/store/memory-store.ts#createMemorySessionStore");
			expect(await call("declare_changes", { claims: guard, why: ["one"] })).toEqual({ text: "", signal: "claim" });
		});

		it("a premise about a symbol that is gone from the code is not asked about", () => {
			expect(unanswered([threw], [], [], () => false)).toEqual([]);
			expect(unanswered([threw], [], [], (symbol) => symbol === VERIFY)).toEqual([threw]);
			// A broken assertion the Intent still holds answers nothing.
			expect(unanswered([threw], [threw], [])).toEqual([threw]);
		});

		it("an Intent that is now changing that symbol itself is not asked about it", async () => {
			const { call } = await redo();
			expect(await call("declare_changes", { claims: [{ symbol: VERIFY, mode: "body" }], why: ["one"], no_behaviour: true })).toEqual({ text: "", signal: "claim" });
		});

		it("only asserted premises count: a type surface that changed is not asked about", () => {
			const observed: Premise = { symbol: VERIFY, source: "observed", surfaceHash: "abc", state: "broken" };
			expect(unanswered([observed], [], [])).toEqual([]);
			expect(unanswered([threw], [], [])).toEqual([threw]);
			expect(unanswered([threw], [{ ...threw, state: "holding" }], [])).toEqual([]);
			expect(unanswered([threw], [{ ...observed, state: "holding" }], [])).toEqual([threw]);
			expect(unanswered([threw], [], [VERIFY])).toEqual([]);
		});
	});

	it("only the library assertions that hold on the fork are offered", async () => {
		const library: Assertion[] = JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]");
		expect((await holding(env, demoFiles(), library)).map((assertion) => assertion.id)).toEqual(["a-session-throws"]);
		expect(await holding(env, demoWith("t01"), library)).toEqual([]);
		expect(await holding(env, demoFiles(), [])).toEqual([]);
	});

	it("withdraws an assertion about a symbol the agent then declares it will change", async () => {
		const { call, api, ctx } = await setup();
		await call("assert_premise", { description: "verifySession throws on expiry", code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.throws(() => verifySession('s1', store, () => 10), SessionExpiredError);", imports: ["src/auth/session.ts", "src/store/memory-store.ts"] });
		expect((await api.get()).premises.filter((premise) => premise.source === "asserted")).toHaveLength(1);
		expect(await call("declare_changes", { claims: [{ symbol: VERIFY, mode: "body" }], why: ["change how expiry is reported"] })).toEqual({ text: "", signal: "claim" });
		expect((await api.get()).premises.filter((premise) => premise.source === "asserted")).toEqual([]);
		expect(ctx.withdrawn).toEqual([`"verifySession throws on expiry" (about ${VERIFY})`]);
	});

	it("is rejected in the work phase", async () => {
		const { call, ctx } = await setup();
		ctx.phase = "work";
		expect(await call("declare_changes", { claims, why: [] })).toMatchObject({ isError: true, text: expect.stringContaining("only allowed in the plan phase") });
	});

	it("validates its input", () => {
		expect(() => parseDeclaration({ claims: [], why: [] })).toThrow(ToolError);
		expect(() => parseDeclaration({ why: [] })).toThrow(/non-empty array/);
		expect(() => parseDeclaration({ claims: [{ symbol: "handleLogin", mode: "body" }], why: [] })).toThrow(/not a symbol id/);
		expect(() => parseDeclaration({ claims: [{ symbol: "src/a.ts#b", mode: "everything" }], why: [] })).toThrow(/mode/);
		expect(() => parseDeclaration({ claims: [{ symbol: "tests/a.test.ts#tests", mode: "body" }], why: [] })).toThrow(/cannot be claimed/);
		expect(() => parseDeclaration({ claims: [{ symbol: "premise/assert.ts#eq", mode: "body" }], why: [] })).toThrow(/cannot be claimed/);
	});

	it("keeps one claim per symbol, preferring interface", () => {
		const parsed = parseDeclaration({ claims: [{ symbol: "src/a.ts#b", mode: "body" }, { symbol: "src/a.ts#b", mode: "interface" }, { symbol: "src/a.ts#c", mode: "body" }], why: "not an array" });
		expect(parsed).toEqual({ claims: [{ symbol: "src/a.ts#b", mode: "interface" }, { symbol: "src/a.ts#c", mode: "body" }], why: [], rejected: [] });
	});
});

describe("write_file", () => {
	it("is rejected in the plan phase", async () => {
		const { call, api } = await setup();
		expect(await call("write_file", { path: LOGIN, content: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("not allowed in the plan phase") });
		expect(await api.overlay()).toEqual({});
	});

	it("stages the file in the work phase, and reads see it", async () => {
		const { call, ctx, api } = await setup();
		ctx.phase = "work";
		expect(await call("write_file", { path: "./src/new/thing.ts", content: "export const thing = 1;\n" })).toEqual({ text: "Wrote src/new/thing.ts (2 lines)." });
		expect(await api.overlay()).toEqual({ "src/new/thing.ts": "export const thing = 1;\n" });
		expect((await call("read_file", { path: "src/new/thing.ts" })).text).toBe("export const thing = 1;\n");
		expect((await call("list_files", { dir: "src/new" })).text).toBe("src/new/thing.ts");
		// A file the agent created is not something it relies on.
		expect((await api.get()).premises).toEqual([]);
	});

	it("refuses hidden paths and bad input", async () => {
		const { call, ctx } = await setup();
		ctx.phase = "work";
		expect(await call("write_file", { path: "premise/tasks.json", content: "[]" })).toMatchObject({ isError: true });
		expect(await call("write_file", { path: ".intent/intent.json", content: "{}" })).toMatchObject({ isError: true });
		expect(await call("write_file", { path: "src/a.ts" })).toMatchObject({ isError: true });
		expect(await call("write_file", { path: "src/a.ts", content: "x".repeat(200_001) })).toMatchObject({ isError: true, text: expect.stringContaining("too large") });
	});
});

describe("write_file and test files", () => {
	it("will not replace a test file that was already in the repo, but lets the Intent write its own", async () => {
		const { call, ctx, api } = await setup();
		ctx.phase = "work";
		// Shared helpers and other people's tests: nothing would notice if these were overwritten.
		for (const path of ["tests/support.ts", "tests/users.test.ts", "tests/billing.test.ts"]) {
			const refused = await call("write_file", { path, content: "export const tests = {};\n" });
			expect(refused).toMatchObject({ isError: true, text: expect.stringContaining(`${path} is an existing test file that other work depends on`) });
			expect(refused.text).toContain("Put your tests in tests/audit-expired.test.ts.");
		}
		expect(await api.overlay()).toEqual({});
		// Its own acceptance test file, and any new file, are its to write.
		expect(await call("write_file", { path: "tests/audit-expired.test.ts", content: "export const tests = {};\n" })).toMatchObject({ text: expect.stringContaining("Wrote tests/audit-expired.test.ts") });
		expect(await call("write_file", { path: "tests/helpers-for-audit.ts", content: "export const x = 1;\n" })).toMatchObject({ text: expect.stringContaining("Wrote tests/helpers-for-audit.ts") });
		// Existing source files are not affected by this rule (claims govern those).
		expect((await call("write_file", { path: LOGIN.split("#")[0], content: "export const y = 1;\n" })).isError).toBeUndefined();
	});
});

describe("run_checks and submit", () => {
	async function working() {
		const s = await setup();
		s.ctx.phase = "work";
		const login = demoFiles()[LOGIN] ?? "";
		const test = demoFiles()["premise/hidden-tests/t02-audit-expired.test.ts"]?.replaceAll("../../src/", "../src/").replace('"../assert.js"', '"../premise/assert.js"').replace('"../assert.js"', '"../premise/assert.js"') ?? "";
		return { ...s, login, test };
	}
	const fixed = (login: string) => login.replace("			return responses.expired();", '			record(deps.audit, "session.expired", deps.now());\n			return responses.expired();');

	it("are rejected in the plan phase", async () => {
		const { call } = await setup();
		expect(await call("run_checks")).toMatchObject({ isError: true });
		expect(await call("submit", { message: "done" })).toMatchObject({ isError: true });
	});

	it("reports type errors and does not run tests", async () => {
		const { call, login } = await working();
		await call("write_file", { path: LOGIN, content: login.replace("return responses.unauthorized();", "return 42;") });
		const result = await call("run_checks");
		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/^Typecheck: FAILED \(1 error\)\n  src\/auth\/login\.ts:\d+: /);
		expect(result.text).toContain("Tests were not run");
	});

	it("reports failing acceptance tests by check id", async () => {
		const { call, test } = await working();
		await call("write_file", { path: "tests/audit-expired.test.ts", content: test });
		const result = await call("run_checks");
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Typecheck: passed");
		expect(result.text).toMatch(/FAIL {2}t02-ac1 {2}tests\/audit-expired\.test\.ts > "an expired session writes an audit entry and returns expired"\n {6}expected 1, got 0/);
		expect(result.text).toContain("PASS  t02-ac2");
		expect(result.text).toContain("Not all checks pass yet.");
	});

	it("reports missing acceptance tests", async () => {
		const { call } = await working();
		expect((await call("run_checks")).text).toContain("test file not found: tests/audit-expired.test.ts");
	});

	it("passes when the work is done, including the Intent's own assertions", async () => {
		const { call, ctx, login, test } = await working();
		ctx.phase = "plan";
		await call("assert_premise", { adopt: "a-session-throws" });
		ctx.phase = "work";
		await call("write_file", { path: LOGIN, content: fixed(login) });
		await call("write_file", { path: "tests/audit-expired.test.ts", content: test });
		const result = await call("run_checks");
		expect(result.isError).toBe(false);
		expect(result.text).toBe(
			[
				"Typecheck: passed",
				'PASS  t02-ac1  tests/audit-expired.test.ts > "an expired session writes an audit entry and returns expired"',
				'PASS  t02-ac2  tests/audit-expired.test.ts > "a missing or unknown session writes no expired entry"',
				'PASS  t02-ac3  tests/audit-expired.test.ts > "a valid session writes no expired entry"',
				"HOLDS   premise a-session-throws",
				"All checks passed. You can submit.",
			].join("\n"),
		);
		expect(await call("submit", { message: "Audit expired sessions" })).toEqual({ text: "Submitted.", signal: "submit" });
	});

	it("submit refuses when nothing was written or the checks fail", async () => {
		const { call, test } = await working();
		expect(await call("submit", { message: "nothing" })).toMatchObject({ isError: true, text: expect.stringContaining("nothing to submit") });
		await call("write_file", { path: "tests/audit-expired.test.ts", content: test });
		const refused = await call("submit", { message: "too early" });
		expect(refused).toMatchObject({ isError: true });
		expect(refused.signal).toBeUndefined();
		expect(refused.text).toContain("Not submitted, because the checks do not pass");
		expect(await call("submit", {})).toMatchObject({ isError: true });
	});
});

describe("callTool", () => {
	it("turns an unknown tool into an error result that names the real ones", async () => {
		const { call } = await setup();
		expect(await call("bash", { command: "ls" })).toMatchObject({ isError: true, text: expect.stringContaining('There is no tool called "bash"') });
	});
});

describe("commitChanges", () => {
	it("adds the Intent record to the agent's edits", async () => {
		const { intent } = await setup();
		const changes = commitChanges(intent, { "src/a.ts": "x" });
		expect(Object.keys(changes).sort()).toEqual([".intent/intent.json", "src/a.ts"]);
		expect(JSON.parse(changes[".intent/intent.json"] ?? "{}")).toMatchObject({ id: intent.id, taskId: "t02-audit-expired", acceptance: intent.acceptance });
	});
});
