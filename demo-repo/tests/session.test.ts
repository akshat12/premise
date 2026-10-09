import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { createSession, DEFAULT_SESSION_TTL_MS, extendSession, isExpired, revokeSession, sessionTtl, verifySession } from "../src/auth/session.js";
import { createMemorySessionStore } from "../src/store/memory-store.js";
import { sequentialIds } from "../src/util/ids.js";
import { fixedClock, HOUR, MINUTE } from "../src/util/time.js";
import { makeSession, now, T0 } from "./support.js";

export const tests: Tests = {
	"verifySession returns null when no token is given": () => {
		const store = createMemorySessionStore([makeSession()]);
		assert.eq(verifySession(undefined, store, now), null);
		assert.eq(verifySession("", store, now), null);
	},
	"verifySession returns null for a token it does not know": () => {
		assert.eq(verifySession("ses_999999", createMemorySessionStore([makeSession()]), now), null);
	},
	"verifySession returns the session for a valid token": () => {
		const session = makeSession();
		assert.deepEq(verifySession(session.id, createMemorySessionStore([session]), now), session);
	},
	"createSession stores a session with the default lifetime": () => {
		const store = createMemorySessionStore();
		const session = createSession("usr_000007", store, now, sequentialIds("session"));
		assert.eq(session.id, "ses_000001");
		assert.eq(session.expiresAt, T0 + DEFAULT_SESSION_TTL_MS);
		assert.deepEq(store.get(session.id), session);
	},
	"sessionTtl counts down and stops at zero": () => {
		const session = makeSession({ expiresAt: T0 + HOUR });
		assert.eq(sessionTtl(session, now), HOUR);
		assert.eq(sessionTtl(session, fixedClock(T0 + 45 * MINUTE)), 15 * MINUTE);
		assert.eq(sessionTtl(session, fixedClock(T0 + 2 * HOUR)), 0);
	},
	"isExpired is true from the expiry instant onwards": () => {
		const session = makeSession({ expiresAt: T0 + HOUR });
		assert.ok(!isExpired(session, fixedClock(T0 + HOUR - 1)));
		assert.ok(isExpired(session, fixedClock(T0 + HOUR)));
	},
	"extendSession pushes the expiry out and saves it": () => {
		const store = createMemorySessionStore([makeSession()]);
		const extended = extendSession(makeSession(), store, fixedClock(T0 + 30 * MINUTE), 2 * HOUR);
		assert.eq(extended.expiresAt, T0 + 30 * MINUTE + 2 * HOUR);
		assert.eq(store.get(extended.id)?.expiresAt, extended.expiresAt);
	},
	"revokeSession removes the session": () => {
		const store = createMemorySessionStore([makeSession()]);
		assert.ok(revokeSession("ses_000001", store));
		assert.ok(!revokeSession("ses_000001", store));
		assert.eq(verifySession("ses_000001", store, now), null);
	},
};
