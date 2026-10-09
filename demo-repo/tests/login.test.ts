import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { createAuditLog, entriesFor, lastEntry } from "../src/auth/audit.js";
import { handleLogin, logout, type PasswordLoginDeps, startLogin } from "../src/auth/login.js";
import { createRateLimiter } from "../src/auth/rate-limit.js";
import { createMemorySessionStore, createMemoryUserStore } from "../src/store/memory-store.js";
import { sequentialIds } from "../src/util/ids.js";
import { MINUTE } from "../src/util/time.js";
import { makeSession, makeUser, now, PASSWORD, T0 } from "./support.js";

function passwordDeps(): PasswordLoginDeps {
	return {
		store: createMemorySessionStore(),
		audit: createAuditLog(),
		now,
		users: createMemoryUserStore([makeUser()]),
		limiter: createRateLimiter({ limit: 3, windowMs: 15 * MINUTE }),
		ids: sequentialIds("session"),
	};
}

export const tests: Tests = {
	"handleLogin resumes a valid session and audits it": () => {
		const deps = { store: createMemorySessionStore([makeSession()]), audit: createAuditLog(), now };
		const response = handleLogin("ses_000001", deps);
		assert.eq(response.status, 200);
		assert.deepEq(response.body, { userId: "usr_000001", expiresAt: makeSession().expiresAt });
		assert.deepEq(lastEntry(deps.audit), { event: "session.resumed", at: T0, subject: "usr_000001" });
	},
	"handleLogin is unauthorized without a token": () => {
		const deps = { store: createMemorySessionStore([makeSession()]), audit: createAuditLog(), now };
		const response = handleLogin(undefined, deps);
		assert.eq(response.status, 401);
		assert.deepEq(response.body, { error: "unauthorized" });
		assert.eq(deps.audit.entries.length, 0);
	},
	"handleLogin is unauthorized for an unknown token": () => {
		const deps = { store: createMemorySessionStore(), audit: createAuditLog(), now };
		assert.deepEq(handleLogin("ses_424242", deps).body, { error: "unauthorized" });
	},
	"startLogin signs in with the right password": () => {
		const deps = passwordDeps();
		const response = startLogin("Ada@Example.com", PASSWORD, deps);
		assert.eq(response.status, 201);
		assert.deepEq(response.body, { token: "ses_000001", userId: "usr_000001", expiresAt: deps.store.get("ses_000001")?.expiresAt });
		assert.eq(entriesFor(deps.audit, "login.succeeded").length, 1);
	},
	"startLogin rejects a wrong password and audits the failure": () => {
		const deps = passwordDeps();
		const response = startLogin("ada@example.com", "wrong", deps);
		assert.eq(response.status, 401);
		assert.deepEq(lastEntry(deps.audit), { event: "login.failed", at: T0, subject: "ada@example.com" });
		assert.eq(deps.store.get("ses_000001"), undefined);
	},
	"startLogin rejects a deactivated user": () => {
		const deps = passwordDeps();
		deps.users.put(makeUser({ status: "deactivated" }));
		assert.eq(startLogin("ada@example.com", PASSWORD, deps).status, 401);
	},
	"startLogin locks out after too many attempts": () => {
		const deps = passwordDeps();
		for (let i = 0; i < 3; i++) {
			assert.eq(startLogin("ada@example.com", "wrong", deps).status, 401);
		}
		const locked = startLogin("ada@example.com", PASSWORD, deps);
		assert.eq(locked.status, 429);
		assert.eq(locked.headers["retry-after"], "900");
		assert.eq(entriesFor(deps.audit, "login.rate_limited").length, 1);
	},
	"logout ends the session and is safe to repeat": () => {
		const deps = { store: createMemorySessionStore([makeSession()]), audit: createAuditLog(), now };
		assert.eq(logout("ses_000001", deps).status, 200);
		assert.eq(deps.store.get("ses_000001"), undefined);
		assert.eq(logout("ses_000001", deps).status, 200);
		assert.eq(entriesFor(deps.audit, "logout").length, 1);
	},
};
