// End to end, with the real session check and a real expired session in the store: what a client
// replaying an expired token actually meets. See README.md in this directory.
import * as assert from "../assert.js";
import type { Tests } from "../assert.js";
import { createRateLimiter, guardRequest } from "../../src/auth/rate-limit.js";
import { createMemorySessionStore } from "../../src/store/memory-store.js";
import { MINUTE } from "../../src/util/time.js";
import { makeSession, now, T0 } from "../../tests/support.js";

function deps() {
	return {
		sessions: createMemorySessionStore([makeSession(), makeSession({ id: "ses_000002", expiresAt: T0 - 1 })]),
		limiter: createRateLimiter({ limit: 3, windowMs: 10 * MINUTE }),
		now,
	};
}

export const tests: Tests = {
	"a client replaying an expired session is turned away on the fourth request": () => {
		const d = deps();
		for (let i = 0; i < 3; i++) {
			assert.eq(guardRequest("client-1", "ses_000002", d).allowed, true);
		}
		assert.deepEq(guardRequest("client-1", "ses_000002", d), { allowed: false, retryAfterMs: 10 * MINUTE });
	},
	"a signed-in client is never turned away by this rule": () => {
		const d = deps();
		for (let i = 0; i < 10; i++) {
			assert.eq(guardRequest("client-1", "ses_000001", d).allowed, true);
		}
	},
};
