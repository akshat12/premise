import { describe, expect, it } from "vitest";
import { demoFiles } from "../testing/demo";
import { functionsCalled, resolveLoosely, tidyAssertion } from "./assertion-input";

const files = demoFiles();
const SESSION = "src/auth/session.ts";

describe("resolveLoosely", () => {
	it("finds the file however the path was written", () => {
		for (const specifier of ["src/auth/session.ts", "./src/auth/session.js", "../auth/session.js", "../../src/auth/session", "./session.js", "auth/session"]) {
			expect(resolveLoosely(specifier, files), specifier).toBe(SESSION);
		}
	});

	it("gives null when nothing matches, or when several files do", () => {
		expect(resolveLoosely("./nowhere.js", files)).toBeNull();
		expect(resolveLoosely("", files)).toBeNull();
		const twins = { "src/a/thing.ts": "", "src/b/thing.ts": "" };
		expect(resolveLoosely("./thing.js", twins)).toBeNull();
		expect(resolveLoosely("src/a/thing.ts", twins)).toBe("src/a/thing.ts");
	});
});

describe("tidyAssertion", () => {
	it("leaves code with no imports alone", () => {
		const code = "assert.throws(() => verifySession('s', store, now), SessionExpiredError);";
		expect(tidyAssertion(code, [SESSION], files)).toEqual({ code, imports: [SESSION], unknown: [] });
	});

	it("removes static imports and lists their files, whatever the relative path", () => {
		const code = 'import { SessionExpiredError } from "./src/auth/session.js";\nimport { verifySession } from "../auth/session.ts";\nimport type { SessionStore } from "./session.js";\n\nconst now = () => 200;\nassert.ok(now() > 0);';
		const tidy = tidyAssertion(code, [], files);
		expect(tidy.code).toBe("const now = () => 200;\nassert.ok(now() > 0);");
		expect(tidy.imports).toEqual([SESSION]);
		expect(tidy.unknown).toEqual([]);
	});

	it("turns a namespace import into an object of that file's exports", () => {
		const tidy = tidyAssertion('import * as session from "./src/auth/session.ts";\nassert.ok(typeof session.verifySession === "function");', [], files);
		expect(tidy.code).toMatch(/^const session = \{ .*verifySession.* \};\nassert\.ok\(typeof session\.verifySession === "function"\);$/);
		expect(tidy.code).toContain("SessionExpiredError");
		expect(tidy.code).not.toContain("SessionStore"); // an interface has no value
		expect(tidy.imports).toEqual([SESSION]);
	});

	it("handles dynamic imports the same way", () => {
		const tidy = tidyAssertion('const { verifySession, SessionExpiredError } = await import("../auth/session.js");\nconst store = await import("../store/memory-store.js");\nassert.ok(store.createMemorySessionStore);', ["src/api/metrics.ts"], files);
		expect(tidy.code).toMatch(/^const store = \{ .*createMemorySessionStore.* \};\nassert\.ok\(store\.createMemorySessionStore\);$/);
		expect(tidy.imports).toEqual(["src/api/metrics.ts", SESSION, "src/store/memory-store.ts"]);
	});

	it("reports an import that matches no file, and still removes the statement", () => {
		const tidy = tidyAssertion('import { x } from "./not/there.js";\nassert.ok(true);', [SESSION], files);
		expect(tidy).toEqual({ code: "assert.ok(true);", imports: [SESSION], unknown: ["./not/there.js"] });
	});
});

describe("functionsCalled", () => {
	it("names the imported functions a check exercises", () => {
		expect(functionsCalled("const s = createMemorySessionStore([]); assert.throws(() => verifySession('x', s, () => 1), SessionExpiredError);", [SESSION, "src/store/memory-store.ts"], files).sort()).toEqual(["createMemorySessionStore", "verifySession"]);
		expect(functionsCalled("assert.ok(session.verifySession (undefined, store, now) === null);", [SESSION], files)).toEqual(["verifySession"]);
	});

	it("is empty for a check that would pass whatever the code does", () => {
		expect(functionsCalled("assert.throws(() => { throw new SessionExpiredError(); }, SessionExpiredError);", [SESSION], files)).toEqual([]);
		expect(functionsCalled('const result = { kind: "expired" }; assert.ok(result.kind === "expired");', ["src/api/handlers.ts"], files)).toEqual([]);
		// Mentioning a function is not calling it.
		expect(functionsCalled("assert.ok(typeof verifySession === 'function');", [SESSION], files)).toEqual([]);
	});
});
