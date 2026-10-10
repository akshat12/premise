import { describe, expect, it } from "vitest";
import type { FileMap } from "../ports/repo-store";
import { demoFiles, demoWith } from "../testing/demo";
import { analyze, diffSurface, fnv1a64, surface, typecheck } from "./index";
import { TS_LIBS } from "./libs";

const SESSION = `export interface Session {
	id: string;
	userId: string;
	expiresAt: number;
}

export interface SessionStore {
	get(id: string): Session | undefined;
}

export class SessionExpiredError extends Error {
	name = "SessionExpiredError";
}

/** Returns null when no token is given. Throws when expired. */
export function verifySession(token: string | undefined, store: SessionStore, now: () => number): Session | null {
	if (token === undefined) {
		return null;
	}
	const session = store.get(token);
	if (session === undefined) {
		return null;
	}
	if (session.expiresAt <= now()) {
		throw new SessionExpiredError("expired");
	}
	return session;
}

export function ttlSeconds(expiresAt: number, now: number): number {
	return Math.max(0, Math.floor((expiresAt - now) / 1000));
}
`;

const LOGIN = `import { type Session, type SessionStore, verifySession } from "./session.js";

export function currentUser(token: string | undefined, store: SessionStore): string | null {
	const session: Session | null = verifySession(token, store, () => 0);
	return session === null ? null : session.userId;
}

export function lookup(token: string, store: SessionStore) {
	return verifySession(token, store, () => 0);
}

export const VERSION = 1;
`;

const base = (): FileMap => ({ "src/auth/session.ts": SESSION, "src/auth/login.ts": LOGIN });
const edited = (path: string, find: string, replace: string): FileMap => {
	const files = base();
	const before = files[path] ?? "";
	if (!before.includes(find)) {
		throw new Error(`fixture does not contain: ${find}`);
	}
	return { ...files, [path]: before.replace(find, replace) };
};
const diff = (after: FileMap) => diffSurface(surface(base()).map, surface(after).map);
const S = (name: string) => `src/auth/session.ts#${name}`;
const L = (name: string) => `src/auth/login.ts#${name}`;

describe("TS_LIBS", () => {
	it("bundles the es2022 lib set without the DOM", () => {
		const names = Object.keys(TS_LIBS);
		expect(names).toContain("lib.es5.d.ts");
		expect(names).toContain("lib.es2022.d.ts");
		expect(names).toContain("lib.es2015.promise.d.ts");
		expect(names).toContain("lib.decorators.d.ts");
		expect(names.some((name) => name.includes(".full.") || name.includes("dom"))).toBe(false);
		expect(names.length).toBeGreaterThan(50);
		expect(TS_LIBS["lib.es5.d.ts"]).toContain("interface Array<T>");
	});
});

describe("surface", () => {
	const { map } = surface(base());

	it("has one entry per exported symbol, keyed like the symbol index", () => {
		expect([...map.keys()].sort()).toEqual([L("VERSION"), L("currentUser"), L("lookup"), S("Session"), S("SessionExpiredError"), S("SessionStore"), S("ttlSeconds"), S("verifySession")].sort());
	});

	it("keeps signatures and drops bodies and comments", () => {
		const verify = map.get(S("verifySession"));
		expect(verify?.decl).toBe("export declare function verifySession(token: string | undefined, store: SessionStore, now: () => number): Session | null;");
		expect(verify?.hash).toBe(fnv1a64(verify?.decl ?? ""));
		expect(verify?.hash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("records which exported symbols each declaration mentions", () => {
		expect(map.get(S("verifySession"))?.refs).toEqual([S("Session"), S("SessionStore")]);
		expect(map.get(S("SessionStore"))?.refs).toEqual([S("Session")]);
		expect(map.get(L("currentUser"))?.refs).toEqual([S("SessionStore")]);
		expect(map.get(S("ttlSeconds"))?.refs).toEqual([]);
	});

	it("follows inferred return types that the emitter writes as inline imports", () => {
		const lookup = map.get(L("lookup"));
		expect(lookup?.decl).toContain("Session | null");
		expect(lookup?.refs).toContain(S("Session"));
	});
});

describe("diffSurface", () => {
	it("is empty for a body-only change", () => {
		expect(diff(edited("src/auth/session.ts", 'throw new SessionExpiredError("expired");', "return null;"))).toEqual({ changed: [], added: [], removed: [] });
	});

	it("is empty for a JSDoc-only change", () => {
		expect(diff(edited("src/auth/session.ts", "Throws when expired.", "Returns null when expired."))).toEqual({ changed: [], added: [], removed: [] });
	});

	it("is empty for the same files", () => {
		expect(diff(base())).toEqual({ changed: [], added: [], removed: [] });
	});

	it("reports a return type change, and what follows from it", () => {
		const result = diff(edited("src/auth/session.ts", "export function ttlSeconds(expiresAt: number, now: number): number {", "export function ttlSeconds(expiresAt: number, now: number): number | null {"));
		expect(result).toEqual({ changed: [S("ttlSeconds")], added: [], removed: [] });
	});

	it("reports an interface field and everything that mentions the interface", () => {
		const result = diff(edited("src/auth/session.ts", "\texpiresAt: number;\n}", "\texpiresAt: number;\n\tcreatedAt?: number;\n}"));
		expect(result.changed).toEqual([L("currentUser"), L("lookup"), S("Session"), S("SessionStore"), S("verifySession")].sort());
		// currentUser never names Session in its signature: it changed through SessionStore.
		expect(result.changed).not.toContain(S("ttlSeconds"));
		expect(result.changed).not.toContain(L("VERSION"));
	});

	it("reports a parameter made optional", () => {
		const result = diff(edited("src/auth/session.ts", "now: () => number): Session | null {", "now?: () => number): Session | null {\n\tnow ??= () => 0;"));
		expect(result.changed).toEqual([S("verifySession")]);
	});

	it("reports a new export", () => {
		const files = base();
		files["src/auth/session.ts"] += "\nexport function revoke(id: string): boolean {\n\treturn id !== \"\";\n}\n";
		expect(diff(files)).toEqual({ changed: [], added: [S("revoke")], removed: [] });
	});

	it("reports a removed export and the symbols that mentioned it", () => {
		const result = diff(edited("src/auth/session.ts", "export function ttlSeconds", "function ttlSeconds"));
		expect(result).toEqual({ changed: [], added: [], removed: [S("ttlSeconds")] });
	});

	it("reports a changed constant's type", () => {
		expect(diff(edited("src/auth/login.ts", "export const VERSION = 1;", 'export const VERSION = "1";')).changed).toEqual([L("VERSION")]);
	});
});

describe("typecheck", () => {
	it("passes a correct repo", () => {
		const result = typecheck(base());
		expect(result.errors).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("reports errors as path:line: message", () => {
		const result = typecheck(edited("src/auth/login.ts", "session.userId;", "session.userName;"));
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/^src\/auth\/login\.ts:5: Property 'userName' does not exist on type 'Session'/);
	});

	it("reports a broken import", () => {
		const result = typecheck(edited("src/auth/login.ts", '"./session.js"', '"./sessions.js"'));
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("src/auth/login.ts:1: Cannot find module './sessions.js'");
	});

	it("does not typecheck tests/ or premise/, but can still read them", () => {
		const files = { ...base(), "tests/broken.test.ts": "const x: number = 'not a number';\n", "premise/also-broken.ts": "nonsense(;\n" };
		expect(typecheck(files).ok).toBe(true);
	});

	it("has the es2022 library available", () => {
		const files = { "src/a.ts": "export const last = [1, 2, 3].at(-1);\nexport const p = Promise.allSettled([Promise.resolve(1)]);\nexport const o = Object.hasOwn({ a: 1 }, 'a');\n" };
		expect(typecheck(files).errors).toEqual([]);
	});

	it("has no DOM or Node globals", () => {
		const result = typecheck({ "src/a.ts": "export const a = document.title;\nexport const b = process.env;\n" });
		expect(result.errors).toHaveLength(2);
	});
});

describe("on the demo repo", () => {
	const base = analyze(demoFiles());

	it("typechecks cleanly", () => {
		expect(base.typecheck.errors).toEqual([]);
		expect(base.typecheck.ok).toBe(true);
	});

	it("has a surface for every indexed symbol", () => {
		expect(base.surface.size).toBeGreaterThanOrEqual(200);
		expect(base.surface.get("src/auth/session.ts#verifySession")?.decl).toBe(
			"export declare function verifySession(token: string | undefined, store: SessionStore, now: () => number): Session | null;",
		);
	});

	it("typecheck plus surface takes under 3 seconds", () => {
		expect(base.ms).toBeLessThan(3000);
	});

	it("names the file when a type error is introduced", () => {
		const files = demoFiles();
		files["src/auth/login.ts"] = (files["src/auth/login.ts"] ?? "").replace("return responses.unauthorized();", "return 42;");
		const result = typecheck(files);
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatch(/^src\/auth\/login\.ts:\d+: /);
	});

	it("the planted t01 change is invisible to types", () => {
		const after = analyze(demoWith("t01"));
		expect(after.typecheck.ok).toBe(true);
		// The signature of verifySession is unchanged, so nothing that relies on its type goes red.
		expect(diffSurface(base.surface, after.surface)).toEqual({ changed: [], added: [], removed: [] });
		expect(after.surface.get("src/auth/session.ts#verifySession")?.hash).toBe(base.surface.get("src/auth/session.ts#verifySession")?.hash);
	});

	it("the textual rebase of t02 onto t01 still typechecks", () => {
		expect(analyze(demoWith("t01", "t02")).typecheck.ok).toBe(true);
	});

	it("an ordinary task that adds an export shows up as added", () => {
		const after = surface(demoWith("t07")).map;
		expect(diffSurface(base.surface, after)).toEqual({ changed: [], added: ["src/users/roles.ts#RESOURCE_MINIMUM", "src/users/roles.ts#Resource", "src/users/roles.ts#canAccess"], removed: [] });
	});

	it("a change to the Session type reaches its users across files", () => {
		const files = demoFiles();
		files["src/auth/session.ts"] = (files["src/auth/session.ts"] ?? "").replace("\texpiresAt: number;\n}", "\texpiresAt: number;\n\tcreatedAt?: number;\n}");
		const changed = diffSurface(base.surface, surface(files).map).changed;
		expect(changed).toContain("src/auth/session.ts#Session");
		expect(changed).toContain("src/auth/session.ts#verifySession");
		expect(changed).toContain("src/api/responses.ts#withSessionHeaders");
		expect(changed).toContain("src/auth/rate-limit.ts#GuardResult");
		expect(changed).not.toContain("src/billing/tax.ts#taxFor");
	});
});
