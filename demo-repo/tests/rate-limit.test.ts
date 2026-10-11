import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { createRateLimiter, DEFAULT_LOGIN_LIMIT, guardRequest } from "../src/auth/rate-limit.js";
import { createMemorySessionStore } from "../src/store/memory-store.js";
import { MINUTE } from "../src/util/time.js";
import { makeSession, now, T0 } from "./support.js";

const config = { limit: 3, windowMs: 10 * MINUTE };

export const tests: Tests = {
	"limiter allows hits up to the limit": () => {
		const limiter = createRateLimiter(config);
		assert.deepEq([1, 2, 3].map(() => limiter.hit("k", T0).allowed), [true, true, true]);
		assert.eq(limiter.hit("k", T0).allowed, false);
	},
	"limiter reports what is left and when to retry": () => {
		const limiter = createRateLimiter(config);
		assert.deepEq(limiter.hit("k", T0), { allowed: true, remaining: 2, retryAfterMs: 0 });
		limiter.hit("k", T0);
		limiter.hit("k", T0);
		assert.deepEq(limiter.hit("k", T0 + MINUTE), { allowed: false, remaining: 0, retryAfterMs: 9 * MINUTE });
	},
	"limiter starts a new window once the old one ends": () => {
		const limiter = createRateLimiter(config);
		for (let i = 0; i < 4; i++) {
			limiter.hit("k", T0);
		}
		assert.eq(limiter.hit("k", T0 + 10 * MINUTE).allowed, true);
	},
	"limiter counts each key separately and can be reset": () => {
		const limiter = createRateLimiter(config);
		for (let i = 0; i < 4; i++) {
			limiter.hit("a", T0);
		}
		assert.eq(limiter.hit("b", T0).allowed, true);
		limiter.reset("a");
		assert.eq(limiter.hit("a", T0).allowed, true);
	},
	"peek does not use up the allowance": () => {
		const limiter = createRateLimiter(config);
		for (let i = 0; i < 10; i++) {
			assert.eq(limiter.peek("k", T0).allowed, true);
		}
		assert.eq(limiter.peek("k", T0).remaining, 3);
		assert.eq(DEFAULT_LOGIN_LIMIT.limit, 5);
	},
	"guardRequest lets a signed-in client through with its session": () => {
		const deps = { sessions: createMemorySessionStore([makeSession()]), limiter: createRateLimiter(config), now };
		assert.deepEq(guardRequest("client-1", "ses_000001", deps), { allowed: true, session: makeSession() });
	},
	"guardRequest lets an anonymous client through with no session": () => {
		const deps = { sessions: createMemorySessionStore(), limiter: createRateLimiter(config), now };
		assert.deepEq(guardRequest("client-1", undefined, deps), { allowed: true, session: null });
	},
	"guardRequest checks the token with the verifier it is given": () => {
		const seen: (string | undefined)[] = [];
		const verify = (token: string | undefined) => {
			seen.push(token);
			return token === "known" ? makeSession() : null;
		};
		const deps = { sessions: createMemorySessionStore(), limiter: createRateLimiter(config), now, verify };
		assert.deepEq(guardRequest("client-1", "known", deps), { allowed: true, session: makeSession() });
		assert.deepEq(guardRequest("client-1", "other", deps), { allowed: true, session: null });
		assert.deepEq(seen, ["known", "other"]);
	},
	"guardRequest turns away a client that is over its limit": () => {
		const deps = { sessions: createMemorySessionStore([makeSession()]), limiter: createRateLimiter(config), now };
		for (let i = 0; i < 3; i++) {
			deps.limiter.hit("client-1", T0);
		}
		assert.deepEq(guardRequest("client-1", "ses_000001", deps), { allowed: false, retryAfterMs: 10 * MINUTE });
		assert.eq(guardRequest("client-2", "ses_000001", deps).allowed, true);
	},
};
