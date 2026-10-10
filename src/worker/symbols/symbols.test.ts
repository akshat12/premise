import { describe, expect, it } from "vitest";
import { DEMO_REPO_FILES } from "../ports/demo-seed";
import { EXPORT_LIST, LOGIN, SESSION } from "./__fixtures__/sources";
import { importMap, indexFile, indexRepo, isIndexedPath, lineDiff, referencedSymbols, resolveImport, touchedSymbols } from "./index";

const PATH = "src/auth/session.ts";
const edit = (source: string, find: string, replace: string) => {
	if (!source.includes(find)) {
		throw new Error(`fixture does not contain: ${find}`);
	}
	return source.replace(find, replace);
};
const touched = (find: string, replace: string) => touchedSymbols(PATH, SESSION, edit(SESSION, find, replace));

describe("indexFile", () => {
	const symbols = indexFile(PATH, SESSION);
	const byName = Object.fromEntries(symbols.map((symbol) => [symbol.name, symbol]));

	it("lists only exported top-level declarations, with their kinds", () => {
		expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
			["SessionExpiredError", "class"],
			["Session", "interface"],
			["verifySession", "function"],
			["ttl", "function"],
			["double", "const"],
			["SessionId", "type"],
			["Mode", "enum"],
		]);
		expect(byName.verifySession?.id).toBe("src/auth/session.ts#verifySession");
	});

	it("starts a symbol at its JSDoc comment", () => {
		const lines = SESSION.split("\n");
		expect(lines[(byName.verifySession?.startLine ?? 0) - 1]).toContain("/** Returns null");
		expect(lines[(byName.verifySession?.endLine ?? 0) - 1]).toBe("}");
	});

	it("ends a function's interface part at the line that opens its body", () => {
		const lines = SESSION.split("\n");
		expect(lines[(byName.verifySession?.signatureEndLine ?? 0) - 1]).toBe("): Session | null {");
		expect(byName.ttl?.signatureEndLine).toBe(byName.ttl?.startLine);
	});

	it("ends a class's interface part at its opening brace", () => {
		expect(byName.SessionExpiredError?.signatureEndLine).toBe(byName.SessionExpiredError?.startLine);
		expect(byName.SessionExpiredError?.endLine).toBe((byName.SessionExpiredError?.startLine ?? 0) + 2);
	});

	it("treats interfaces, types and enums as all interface", () => {
		for (const name of ["Session", "SessionId", "Mode"]) {
			expect(byName[name]?.signatureEndLine).toBe(byName[name]?.endLine);
		}
	});

	it("treats a const holding a function like a function", () => {
		expect(byName.double?.signatureEndLine).toBe(byName.double?.startLine);
		expect(byName.double?.endLine).toBe((byName.double?.startLine ?? 0) + 2);
	});

	it("follows `export { a, b as c }` to local declarations and names `export default`", () => {
		const listed = indexFile("src/x.ts", EXPORT_LIST);
		expect(listed.map((symbol) => [symbol.name, symbol.kind, symbol.startLine])).toEqual([
			["alpha", "function", 1],
			["gamma", "const", 5],
			["default", "const", 13],
		]);
		// A re-export from another module is not a local symbol.
		expect(listed.some((symbol) => symbol.name === "other")).toBe(false);
	});

	it("names `export default function` as default", () => {
		const symbols = indexFile("src/x.ts", "export default function run(): void {}\n");
		expect(symbols.map((symbol) => symbol.id)).toEqual(["src/x.ts#default"]);
	});
});

describe("lineDiff", () => {
	it("reports a replaced line", () => {
		expect(lineDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual([{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 2 }]);
	});

	it("reports an insertion with an empty old range", () => {
		expect(lineDiff("a\nc\n", "a\nb\nc\n")).toEqual([{ oldStart: 2, oldEnd: 1, newStart: 2, newEnd: 2 }]);
	});

	it("reports a deletion with an empty new range", () => {
		expect(lineDiff("a\nb\nc\n", "a\nc\n")).toEqual([{ oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 1 }]);
	});

	it("reports separate hunks separately", () => {
		expect(lineDiff("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n")).toEqual([
			{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 1 },
			{ oldStart: 5, oldEnd: 5, newStart: 5, newEnd: 5 },
		]);
	});

	it("ignores whitespace-only changes and added blank lines", () => {
		expect(lineDiff("a\n\tb\nc\n", "a\n    b  \n\nc\n")).toEqual([]);
		expect(lineDiff("same\n", "same\n")).toEqual([]);
	});

	it("handles empty files", () => {
		expect(lineDiff("", "a\nb\n")).toEqual([{ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: 2 }]);
		expect(lineDiff("a\n", "")).toEqual([{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 0 }]);
	});
});

describe("touchedSymbols", () => {
	const VERIFY = "src/auth/session.ts#verifySession";

	it("function body edit gives body", () => {
		expect(touched('throw new SessionExpiredError("expired");', "return null;")).toEqual([{ symbol: VERIFY, part: "body" }]);
	});

	it("parameter rename gives interface", () => {
		expect(touched("\ttoken: string | undefined,\n", "\tbearer: string | undefined,\n")).toContainEqual({ symbol: VERIFY, part: "interface" });
	});

	it("return type change gives interface", () => {
		expect(touched("): Session | null {", "): Session | undefined {")).toEqual([{ symbol: VERIFY, part: "interface" }]);
	});

	it("JSDoc-only change gives interface", () => {
		expect(touched("Throws when the session is expired.", "Returns null when the session is expired.")).toEqual([{ symbol: VERIFY, part: "interface" }]);
	});

	it("new export gives interface on the new symbol", () => {
		const next = `${SESSION}\nexport function revoke(id: string): boolean {\n\treturn id.length > 0;\n}\n`;
		expect(touchedSymbols(PATH, SESSION, next)).toEqual([{ symbol: "src/auth/session.ts#revoke", part: "interface" }]);
	});

	it("deleted export gives interface", () => {
		expect(touched("export type SessionId = string;\n", "")).toEqual([{ symbol: "src/auth/session.ts#SessionId", part: "interface" }]);
	});

	it("removing the export keyword counts as a removed export", () => {
		expect(touched("export function ttl()", "function ttl()")).toEqual([{ symbol: "src/auth/session.ts#ttl", part: "interface" }]);
	});

	it("edit to a private helper gives body on its callers only", () => {
		expect(touched("return at <= now();", "return at < now();")).toEqual([{ symbol: VERIFY, part: "body" }]);
	});

	it("edit to a private constant gives body on the exports that use it", () => {
		expect(touched("const DEFAULT_TTL = 12 * HOUR;", "const DEFAULT_TTL = 24 * HOUR;")).toEqual([{ symbol: "src/auth/session.ts#ttl", part: "body" }]);
	});

	it("follows helper-to-helper chains", () => {
		const source = "function a(): number {\n\treturn 1;\n}\n\nfunction b(): number {\n\treturn a();\n}\n\nexport function c(): number {\n\treturn b();\n}\n\nexport function d(): number {\n\treturn 4;\n}\n";
		expect(touchedSymbols("src/x.ts", source, source.replace("return 1;", "return 2;"))).toEqual([{ symbol: "src/x.ts#c", part: "body" }]);
	});

	it("interface field added gives interface", () => {
		expect(touched("\texpiresAt: number;\n", "\texpiresAt: number;\n\tcreatedAt: number;\n")).toEqual([{ symbol: "src/auth/session.ts#Session", part: "interface" }]);
	});

	it("class body edit gives body, class heritage edit gives interface", () => {
		expect(touched('name = "SessionExpiredError";', 'name = "Expired";')).toEqual([{ symbol: "src/auth/session.ts#SessionExpiredError", part: "body" }]);
		expect(touched("extends Error {", "extends TypeError {")).toEqual([{ symbol: "src/auth/session.ts#SessionExpiredError", part: "interface" }]);
	});

	it("a body edit in a const arrow function gives body", () => {
		expect(touched("return n * 2;", "return n + n;")).toEqual([{ symbol: "src/auth/session.ts#double", part: "body" }]);
	});

	it("an edit through an `export { x }` list is attributed to the exported name", () => {
		expect(touchedSymbols("src/x.ts", EXPORT_LIST, EXPORT_LIST.replace("const beta = 2;", "const beta = 20;"))).toEqual([{ symbol: "src/x.ts#gamma", part: "interface" }]);
	});

	it("a new file touches every export, and so does a deleted file", () => {
		const all = indexFile(PATH, SESSION).map((symbol) => ({ symbol: symbol.id, part: "interface" })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
		expect(touchedSymbols(PATH, null, SESSION)).toEqual(all);
		expect(touchedSymbols(PATH, SESSION, null)).toEqual(all);
	});

	it("whitespace-only and import-only edits touch nothing", () => {
		expect(touched("\tif (token === undefined) {", "\tif (token === undefined)   {")).toEqual([]);
		expect(touched('import { HOUR } from "../util/time.js";', 'import { HOUR, DAY } from "../util/time.js";')).toEqual([]);
		expect(touchedSymbols(PATH, SESSION, SESSION)).toEqual([]);
	});

	it("reports interface when one edit changes both signature and body", () => {
		const next = edit(edit(SESSION, "): Session | null {", "): Session | undefined {"), 'throw new SessionExpiredError("expired");', "return undefined;");
		expect(touchedSymbols(PATH, SESSION, next)).toEqual([{ symbol: VERIFY, part: "interface" }]);
	});
});

describe("importMap and resolveImport", () => {
	it("resolves relative specifiers to repo paths ending in .ts", () => {
		expect(resolveImport("src/auth/login.ts", "../util/time")).toBe("src/util/time.ts");
		expect(resolveImport("src/auth/login.ts", "./session.js")).toBe("src/auth/session.ts");
		expect(resolveImport("src/auth/login.ts", "../../shared/x.ts")).toBe("shared/x.ts");
		expect(resolveImport("src/auth/login.ts", "some-package")).toBeNull();
		expect(resolveImport("src/auth/login.ts", "node:fs")).toBeNull();
	});

	it("maps imported names, including aliases, defaults and type imports", () => {
		const map = importMap("src/auth/login.ts", LOGIN);
		expect(Object.fromEntries(map)).toEqual({
			ApiResponse: "src/api/responses.ts#ApiResponse",
			clock: "src/util/time.ts#now",
			defaultLimiter: "src/auth/rate-limit.ts#default",
			SessionExpiredError: "src/auth/session.ts#SessionExpiredError",
			Session: "src/auth/session.ts#Session",
			verifySession: "src/auth/session.ts#verifySession",
		});
	});
});

describe("referencedSymbols", () => {
	it("finds imports used in the file, namespace members, and same-file exports", () => {
		expect(referencedSymbols("src/auth/login.ts", LOGIN)).toEqual([
			"src/api/responses.ts#ApiResponse",
			"src/api/responses.ts#expired",
			"src/api/responses.ts#ok",
			"src/api/responses.ts#unauthorized",
			"src/auth/login.ts#LoginDeps",
			"src/auth/rate-limit.ts#default",
			"src/auth/session.ts#Session",
			"src/auth/session.ts#SessionExpiredError",
			"src/auth/session.ts#verifySession",
			"src/util/time.ts#now",
		]);
	});

	it("limits the search to the given line ranges", () => {
		const lines = LOGIN.split("\n");
		const line = lines.findIndex((text) => text.includes("verifySession(token")) + 1;
		expect(referencedSymbols("src/auth/login.ts", LOGIN, [{ start: line, end: line }])).toEqual(["src/auth/session.ts#verifySession", "src/util/time.ts#now"]);
		expect(referencedSymbols("src/auth/login.ts", LOGIN, [])).toEqual([]);
	});

	it("does not count a property that merely shares an import's name", () => {
		const source = 'import { ok } from "./responses.js";\nexport function f(result: { ok: boolean }): boolean {\n\treturn result.ok;\n}\n';
		expect(referencedSymbols("src/api/x.ts", source)).toEqual([]);
	});
});

describe("indexRepo on the demo repo", () => {
	const index = indexRepo(DEMO_REPO_FILES);

	it("finds 200 or more exported symbols", () => {
		expect(index.size).toBeGreaterThanOrEqual(200);
		expect(index.has("src/auth/session.ts#verifySession")).toBe(true);
		expect(index.get("src/auth/login.ts#handleLogin")?.kind).toBe("function");
	});

	it("skips tests/ and premise/", () => {
		expect([...index.keys()].some((id) => id.startsWith("tests/") || id.startsWith("premise/"))).toBe(false);
		expect(isIndexedPath("tests/login.test.ts")).toBe(false);
		expect(isIndexedPath("premise/assert.ts")).toBe(false);
		expect(isIndexedPath("src/auth/session.ts")).toBe(true);
		expect(isIndexedPath("package.json")).toBe(false);
	});

	it("sees the planted change as a body touch on verifySession only", () => {
		const before = DEMO_REPO_FILES["src/auth/session.ts"] ?? "";
		const after = before.replace("throw new SessionExpiredError(`session ${session.id} expired`);", "return null;");
		expect(after).not.toBe(before);
		expect(touchedSymbols("src/auth/session.ts", before, after)).toEqual([{ symbol: "src/auth/session.ts#verifySession", part: "body" }]);
	});

	it("resolves what handleLogin relies on", () => {
		const login = DEMO_REPO_FILES["src/auth/login.ts"] ?? "";
		const refs = referencedSymbols("src/auth/login.ts", login);
		expect(refs).toContain("src/auth/session.ts#verifySession");
		expect(refs).toContain("src/auth/session.ts#SessionExpiredError");
		expect(refs).toContain("src/api/responses.ts#expired");
		expect(refs).toContain("src/auth/audit.ts#record");
	});
});
