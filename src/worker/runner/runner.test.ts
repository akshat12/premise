import { describe, expect, it } from "vitest";
import type { Assertion } from "../../shared/types";
import { demoFiles } from "../testing/demo";
import { assertionSource, buildModules, moduleKey, normalizeImportPath, normalizeSpecifiers, planRun, RUNNER_MODULE, startFailureModule, transpile } from "./index";

const SESSION_THROWS: Assertion = JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]")[0];

describe("transpile", () => {
	it("strips types and keeps .js specifiers", () => {
		const out = transpile("src/a.ts", 'import { type B, c } from "./b.js";\nexport function a(x: number): number {\n\treturn c(x);\n}\n');
		expect(out.syntaxError).toBeUndefined();
		expect(out.js).toContain('import { c } from "./b.js";');
		expect(out.js).toContain("export function a(x) {");
		expect(out.js).not.toContain("number");
	});

	it("guards every kind of loop", () => {
		const out = transpile("src/loops.ts", "export function f(xs: number[]) {\n\tfor (;;) { break; }\n\tfor (const x of xs) x;\n\tfor (const k in xs) k;\n\twhile (false) {}\n\tdo {} while (false);\n}\n");
		expect(out.js.match(/__premiseTick\(\)/g)).toHaveLength(5);
	});

	it("reports a syntax error with its file and line", () => {
		const out = transpile("tests/bad.test.ts", "export const tests = {\n\tbroken: () => { const = 1; },\n};\n");
		expect(out.syntaxError).toMatch(/^tests\/bad\.test\.ts:2: /);
	});
});

describe("normalizeSpecifiers", () => {
	it("gives every relative specifier a .js extension", () => {
		expect(normalizeSpecifiers('import { a } from "./a";\nimport b from "../b.ts";\nexport * from "./c.js";\nconst d = await import("./d");\nimport "./side";')).toBe(
			'import { a } from "./a.js";\nimport b from "../b.js";\nexport * from "./c.js";\nconst d = await import("./d.js");\nimport "./side.js";',
		);
	});

	it("leaves package imports alone", () => {
		expect(normalizeSpecifiers('import { WorkerEntrypoint } from "cloudflare:workers";\nimport x from "pkg";')).toBe('import { WorkerEntrypoint } from "cloudflare:workers";\nimport x from "pkg";');
	});
});

describe("assertionSource", () => {
	it("imports assert and every runtime export of the assertion's modules", () => {
		const { source, error } = assertionSource(SESSION_THROWS, demoFiles());
		expect(error).toBeUndefined();
		expect(source).toContain('import * as assert from "./premise/assert.js";');
		expect(source).toContain('import * as m0 from "./src/auth/session.js";');
		expect(source).toContain('import * as m1 from "./src/store/memory-store.js";');
		const scope = /const \{ ([^}]*) \} = \{ \.\.\.m0, \.\.\.m1 \};/.exec(source)?.[1]?.split(", ") ?? [];
		expect(scope).toEqual(expect.arrayContaining(["verifySession", "SessionExpiredError", "createMemorySessionStore"]));
		// Types have no runtime value, so they are not pulled into scope.
		expect(source).not.toMatch(/const \{[^}]*\bSessionStore\b/);
		expect(source).toContain(SESSION_THROWS.code);
	});

	it("tolerates sloppy import paths", () => {
		expect(["./src/auth/session.ts", "/src/auth/session.ts", "src/auth/session", "src/auth/session.js", "src/auth/session.ts#verifySession"].map(normalizeImportPath)).toEqual(Array(5).fill("src/auth/session.ts"));
	});

	it("reports an import that does not exist", () => {
		expect(assertionSource({ ...SESSION_THROWS, imports: ["src/auth/nope.ts"] }, demoFiles()).error).toBe("assertion imports a file that does not exist: src/auth/nope.ts");
	});
});

describe("planRun and buildModules", () => {
	const request = { files: demoFiles(), tests: [{ file: "tests/session.test.ts", name: "verifySession returns null when no token is given" }], assertions: [SESSION_THROWS] };

	it("loads the repo source, the assert library, the needed test files and what they import", () => {
		const modules = buildModules(request);
		const keys = Object.keys(modules);
		expect(keys).toContain("src/auth/session.js");
		expect(keys).toContain("premise/assert.js");
		expect(keys).toContain("tests/session.test.js");
		expect(keys).toContain("tests/support.js"); // imported by the test file
		expect(keys).toContain("__assert_0.js");
		expect(keys).toContain(RUNNER_MODULE);
		// Not needed, so not loaded.
		expect(keys).not.toContain("tests/login.test.js");
		expect(keys.some((key) => key.startsWith("premise/reference/") || key.startsWith("premise/hidden-tests/") || key === "premise/run-tests.js")).toBe(false);
		expect(keys.every((key) => key.endsWith(".js"))).toBe(true);
		expect(moduleKey("src/auth/session.ts")).toBe("src/auth/session.js");
	});

	it("is deterministic", () => {
		expect(buildModules(request)).toEqual(buildModules(request));
	});

	it("turns a syntax error in the repo's source into a load error", () => {
		const files = { ...demoFiles(), "src/auth/audit.ts": "export const = ;\n" };
		expect(planRun({ ...request, files }).loadError).toMatch(/^syntax error in src\/auth\/audit\.ts:1: /);
	});

	it("fails only the affected items for a broken test file, a missing test file or a broken assertion", () => {
		const files = { ...demoFiles(), "tests/bad.test.ts": "export const tests = { x: () => { const = 1; } };\n" };
		const plan = planRun({
			files,
			tests: [{ file: "tests/session.test.ts", name: "a" }, { file: "tests/bad.test.ts", name: "x" }, { file: "tests/missing.test.ts", name: "y" }],
			assertions: [SESSION_THROWS, { ...SESSION_THROWS, id: "bad", code: "assert.ok(;" }, { ...SESSION_THROWS, id: "nofile", imports: ["src/nope.ts"] }],
		});
		expect(plan.loadError).toBeUndefined();
		expect(plan.items.map((item) => `${item.kind}:${item.index}`)).toEqual(["test:0", "assertion:0"]);
		expect(Object.fromEntries(plan.failures)).toEqual({
			"test:1": expect.stringMatching(/^syntax error in tests\/bad\.test\.ts:1: /),
			"test:2": "test file not found: tests/missing.test.ts",
			"assertion:1": expect.stringMatching(/^the assertion's code does not parse: /),
			"assertion:2": "assertion imports a file that does not exist: src/nope.ts",
		});
		// The broken modules are left out, so they cannot stop the Worker from starting.
		expect(Object.keys(plan.modules)).not.toContain("tests/bad.test.js");
		expect(Object.keys(plan.modules)).not.toContain("__assert_1.js");
	});
});

describe("startFailureModule", () => {
	const modules = { "__runner.js": "", "__assert_1.js": "", "tests/x.test.js": "", "src/a.js": "" };

	it("finds the module a start failure names", () => {
		expect(startFailureModule("Failed to start Worker:\nUncaught SyntaxError: Unexpected token '='\n  at __assert_1.js:5:13", modules)).toBe("__assert_1.js");
		expect(startFailureModule("Uncaught SyntaxError: Identifier 'a' has already been declared\n  at tests/x.test.js:2:7", modules)).toBe("tests/x.test.js");
	});

	it("ignores modules it did not load, and the runner itself", () => {
		expect(startFailureModule("Uncaught SyntaxError: bad\n  at other.js:1:1", modules)).toBeUndefined();
		expect(startFailureModule("Uncaught Error: boom\n  at __runner.js:3:1", modules)).toBeUndefined();
		expect(startFailureModule("exceeded CPU limit", modules)).toBeUndefined();
	});
});
