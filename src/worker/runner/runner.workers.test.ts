import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Assertion, TaskDef } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import { demoFiles, demoWith } from "../testing/demo";
import { runInIsolate } from "./index";

const SESSION_THROWS: Assertion = JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]")[0];
const TASKS: TaskDef[] = JSON.parse(demoFiles()["premise/tasks.json"] ?? "[]");
const acceptance = (taskId: string) => (TASKS.find((task) => task.id === taskId)?.acceptance ?? []).map((check) => ({ file: check.testFile, name: check.testName }));

/** Every test in a file, by reading the names out of the source. */
function allTestsIn(files: FileMap, file: string) {
	const names = [...(files[file] ?? "").matchAll(/^\t"([^"]+)": (?:async )?\(\) =>/gm)].map((match) => match[1] as string);
	return names.map((name) => ({ file, name }));
}

describe("runInIsolate: the demo repo", () => {
	it("passes every test in tests/session.test.ts on trunk", async () => {
		const files = demoFiles();
		const tests = allTestsIn(files, "tests/session.test.ts");
		expect(tests).toHaveLength(8);
		const result = await runInIsolate(env, { files, tests, assertions: [] });
		expect(result.loadError).toBeUndefined();
		expect(result.tests.filter((test) => !test.ok)).toEqual([]);
		expect(result.tests.map((test) => test.name)).toEqual(tests.map((test) => test.name));
	});

	it("passes the whole trunk test suite", async () => {
		const files = demoFiles();
		const testFiles = Object.keys(files).filter((path) => path.startsWith("tests/") && path.endsWith(".test.ts"));
		const tests = testFiles.flatMap((file) => allTestsIn(files, file));
		expect(tests.length).toBeGreaterThanOrEqual(90);
		const result = await runInIsolate(env, { files, tests, assertions: [] });
		expect(result.tests.filter((test) => !test.ok)).toEqual([]);
	});

	it("a-session-throws holds on trunk", async () => {
		const result = await runInIsolate(env, { files: demoFiles(), tests: [], assertions: [SESSION_THROWS] });
		expect(result.assertions).toEqual([{ id: "a-session-throws", ok: true, ms: expect.any(Number) }]);
	});
});

describe("runInIsolate: the planted scenario", () => {
	it("after t01, a-session-throws fails and the t01 acceptance tests pass", async () => {
		const result = await runInIsolate(env, { files: demoWith("t01"), tests: acceptance("t01-null-expired"), assertions: [SESSION_THROWS] });
		expect(result.assertions).toEqual([{ id: "a-session-throws", ok: false, error: "expected the function to throw SessionExpiredError, but it returned", ms: expect.any(Number) }]);
		expect(result.tests.map((test) => test.ok)).toEqual([true, true]);
	});

	it("t02 passes its acceptance tests on trunk", async () => {
		const result = await runInIsolate(env, { files: demoWith("t02"), tests: acceptance("t02-audit-expired"), assertions: [SESSION_THROWS] });
		expect(result.tests.map((test) => test.ok)).toEqual([true, true, true]);
		expect(result.assertions[0]?.ok).toBe(true);
	});

	it("t02 rebased textually onto t01 fails its acceptance test, for the behavioural reason", async () => {
		const result = await runInIsolate(env, { files: demoWith("t01", "t02"), tests: acceptance("t02-audit-expired"), assertions: [] });
		expect(result.loadError).toBeUndefined();
		expect(result.tests[0]).toMatchObject({ name: "an expired session writes an audit entry and returns expired", ok: false, error: 'expected {"error":"session_expired"}, got {"error":"unauthorized"}' });
		// The other two checks (no false audit entries) still pass, so this is not a broken test file.
		expect(result.tests.slice(1).map((test) => test.ok)).toEqual([true, true]);
	});

	it("the re-derived t02 passes on top of t01", async () => {
		const result = await runInIsolate(env, { files: demoWith("t01", "t02-rederived"), tests: acceptance("t02-audit-expired"), assertions: [] });
		expect(result.tests.map((test) => test.ok)).toEqual([true, true, true]);
	});

	it("the same holds for t03", async () => {
		const rebased = await runInIsolate(env, { files: demoWith("t01", "t03"), tests: acceptance("t03-expired-metrics"), assertions: [] });
		expect(rebased.tests[0]?.ok).toBe(false);
		const rederived = await runInIsolate(env, { files: demoWith("t01", "t03-rederived"), tests: acceptance("t03-expired-metrics"), assertions: [] });
		expect(rederived.tests.every((test) => test.ok)).toBe(true);
	});

	it("t11 is the one tests do not catch: after t01 its tests pass, and only the premise and the end-to-end probe fail", async () => {
		const PROBE = "premise/probes/t11-expired-rate-limit.test.ts";
		const probe = [{ file: PROBE, name: "a client replaying an expired session is turned away on the fourth request" }, { file: PROBE, name: "a signed-in client is never turned away by this rule" }];
		const task = "t11-expired-rate-limit";
		// On the trunk it was written against, everything holds.
		const onTrunk = await runInIsolate(env, { files: demoWith("t11"), tests: [...acceptance(task), ...probe], assertions: [SESSION_THROWS] });
		expect(onTrunk.tests.every((test) => test.ok)).toBe(true);
		expect(onTrunk.assertions[0]?.ok).toBe(true);
		// Rebased onto t01: its own tests use a stand-in for the session check, which still throws, so they pass.
		const rebased = await runInIsolate(env, { files: demoWith("t01", "t11"), tests: [...acceptance(task), ...probe], assertions: [SESSION_THROWS] });
		expect(rebased.tests.slice(0, 3).map((test) => test.ok)).toEqual([true, true, true]);
		expect(rebased.assertions[0]).toMatchObject({ ok: false, error: "expected the function to throw SessionExpiredError, but it returned" });
		expect(rebased.tests[3]).toMatchObject({ ok: false, error: 'expected {"allowed":false,"retryAfterMs":600000}, got {"allowed":true,"session":null}' });
		expect(rebased.tests[4]?.ok).toBe(true);
		// Re-derived: the tests and the probe both pass.
		const rederived = await runInIsolate(env, { files: demoWith("t01", "t11-rederived"), tests: [...acceptance(task), ...probe], assertions: [] });
		expect(rederived.tests.every((test) => test.ok)).toBe(true);
	});
});

describe("runInIsolate: hostile or broken code", () => {
	const withTest = (body: string): FileMap => ({ ...demoFiles(), "tests/x.test.ts": `import * as assert from "../premise/assert.js";\nexport const tests = {\n${body}\n};\n` });
	const run = (files: FileMap, names: string[]) => runInIsolate(env, { files, tests: names.map((name) => ({ file: "tests/x.test.ts", name })), assertions: [] });

	it("stops an infinite loop and reports it as failed, without hanging", async () => {
		const files = withTest('\t"spins": () => { for (;;) {} },\n\t"fine": () => { assert.eq(1, 1); },\n\t"spins in a while": () => { let n = 0; while (true) { n++; } },');
		const started = Date.now();
		const result = await run(files, ["spins", "fine", "spins in a while"]);
		expect(Date.now() - started).toBeLessThan(15_000);
		expect(result.tests.map((test) => test.ok)).toEqual([false, true, false]);
		expect(result.tests[0]?.error).toContain("possible infinite loop");
	}, 30_000);

	it("stops an infinite loop inside the repo's own code", async () => {
		const files = withTest('\t"calls a spinning function": () => { spin(); },');
		files["src/util/spin.ts"] = "export function spin(): never {\n\tdo {} while (true);\n}\n";
		files["tests/x.test.ts"] = `import { spin } from "../src/util/spin.js";\n${files["tests/x.test.ts"]}`;
		expect((await run(files, ["calls a spinning function"])).tests[0]).toMatchObject({ ok: false, error: expect.stringContaining("possible infinite loop") });
	}, 30_000);

	it("fails a test that never settles, and keeps going", async () => {
		const files = withTest('\t"hangs": () => new Promise<void>(() => {}),\n\t"fine": () => {},');
		const result = await run(files, ["hangs", "fine"]);
		expect(result.tests).toMatchObject([{ ok: false, error: "timed out after 5000 ms" }, { ok: true }]);
	}, 30_000);

	it("blocks outbound network access", async () => {
		const files = withTest('\t"calls fetch": async () => { await fetch("https://example.com"); },');
		const result = await run(files, ["calls fetch"]);
		expect(result.tests[0]?.ok).toBe(false);
		expect(result.tests[0]?.error).toMatch(/not permitted to access the internet/);
	});

	it("reports a thrown error, a missing test name and a missing export per item", async () => {
		const files = withTest('\t"throws": () => { throw new TypeError("boom"); },\n\t"asserts": () => { assert.eq(1, 2, "numbers"); },');
		files["tests/empty.test.ts"] = "export const nothing = 1;\n";
		const result = await runInIsolate(env, {
			files,
			tests: [{ file: "tests/x.test.ts", name: "throws" }, { file: "tests/x.test.ts", name: "asserts" }, { file: "tests/x.test.ts", name: "no such test" }, { file: "tests/empty.test.ts", name: "x" }, { file: "tests/gone.test.ts", name: "y" }],
			assertions: [],
		});
		expect(result.tests.map((test) => test.error)).toEqual(["TypeError: boom", "numbers: expected 2, got 1", 'no test named "no such test"', "the test file does not export `tests`", "test file not found: tests/gone.test.ts"]);
	});

	it("fails only the test file that imports something that does not exist", async () => {
		const files = withTest('\t"fine": () => {},');
		files["tests/bad-import.test.ts"] = 'import { nope } from "../src/auth/session.js";\nexport const tests = { uses: () => nope };\n';
		const result = await runInIsolate(env, { files, tests: [{ file: "tests/bad-import.test.ts", name: "uses" }, { file: "tests/x.test.ts", name: "fine" }], assertions: [] });
		expect(result.loadError).toBeUndefined();
		expect(result.tests[0]).toMatchObject({ ok: false, error: expect.stringContaining("does not provide an export named 'nope'") });
		expect(result.tests[1]?.ok).toBe(true);
	});

	it("fails only the broken assertion when one of several does not parse or throws", async () => {
		const result = await runInIsolate(env, {
			files: demoFiles(),
			tests: [],
			assertions: [
				SESSION_THROWS,
				{ id: "syntax", description: "broken", imports: ["src/auth/session.ts"], code: "assert.ok(;" },
				{ id: "false", description: "wrong", imports: ["src/billing/tax.ts"], code: "assert.eq(taxFor(100, 1000), 11);" },
				{ id: "async", description: "awaits", imports: ["src/billing/tax.ts"], code: "await Promise.resolve(); assert.eq(taxFor(100, 1000), 10);" },
				{ id: "typed", description: "TypeScript in the body", imports: ["src/billing/tax.ts"], code: "const rate: number = 1000; assert.eq(taxFor(100, rate) as number, 10);" },
			],
		});
		expect(result.assertions.map((assertion) => [assertion.id, assertion.ok, assertion.error])).toEqual([
			["a-session-throws", true, undefined],
			["syntax", false, expect.any(String)],
			["false", false, "expected 11, got 10"],
			["async", true, undefined],
			["typed", true, undefined],
		]);
		expect(result.assertions[1]?.error).toMatch(/^the assertion's code does not parse: /);
		expect(result.assertions[2]?.error).toBe("expected 11, got 10");
	});

	it("survives code that only JavaScript, not the transpiler, rejects", async () => {
		// A redeclared const and an import inside a function both transpile without complaint, and
		// either one would stop the whole Worker from starting.
		const files = withTest('\t"fine": () => {},');
		files["tests/redeclared.test.ts"] = "const a = 1;\nconst a = 2;\nexport const tests = { x: () => {} };\n";
		const result = await runInIsolate(env, {
			files,
			tests: [{ file: "tests/redeclared.test.ts", name: "x" }, { file: "tests/x.test.ts", name: "fine" }],
			assertions: [SESSION_THROWS, { id: "import-inside", description: "bad", imports: ["src/billing/tax.ts"], code: 'import { nope } from "./src/billing/tax.js"; assert.ok(nope);' }],
		});
		expect(result.loadError).toBeUndefined();
		expect(result.tests.map((test) => test.ok)).toEqual([false, true]);
		expect(result.tests[0]?.error).toMatch(/SyntaxError.*already been declared/);
		expect(result.assertions.map((assertion) => assertion.ok)).toEqual([true, false]);
		expect(result.assertions[1]?.error).toMatch(/SyntaxError/);
	});

	it("marks everything failed with a load error when the repo's source does not parse", async () => {
		const files = { ...demoFiles(), "src/auth/audit.ts": "export const = ;\n" };
		const result = await runInIsolate(env, { files, tests: [{ file: "tests/session.test.ts", name: "verifySession returns null when no token is given" }], assertions: [SESSION_THROWS] });
		expect(result.loadError).toMatch(/^syntax error in src\/auth\/audit\.ts:1: /);
		expect(result.tests[0]).toMatchObject({ ok: false, error: result.loadError });
		expect(result.assertions[0]).toMatchObject({ ok: false, error: result.loadError });
	});

	it("gives each run a fresh isolate, so module state does not leak between runs", async () => {
		const files = withTest('\t"counts": () => { assert.eq(next(), 1); },');
		files["src/util/counter.ts"] = "let n = 0;\nexport function next(): number {\n\treturn ++n;\n}\n";
		files["tests/x.test.ts"] = `import { next } from "../src/util/counter.js";\n${files["tests/x.test.ts"]}`;
		expect((await run(files, ["counts"])).tests[0]?.ok).toBe(true);
		expect((await run(files, ["counts"])).tests[0]?.ok).toBe(true);
	});

	it("returns an empty result for an empty request", async () => {
		expect(await runInIsolate(env, { files: demoFiles(), tests: [], assertions: [] })).toEqual({ tests: [], assertions: [] });
	});
});
