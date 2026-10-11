import { type Clock, MINUTE } from "../util/time.js";
import { type Session, SessionExpiredError, type SessionStore, verifySession } from "./session.js";

export interface RateLimitConfig {
	/** Hits allowed per window. */
	limit: number;
	windowMs: number;
}

export interface RateLimitDecision {
	allowed: boolean;
	remaining: number;
	/** How long until the window resets. Zero when allowed. */
	retryAfterMs: number;
}

export interface RateLimiter {
	/** Counts one hit for `key` and says whether it was within the limit. */
	hit(key: string, at: number): RateLimitDecision;
	/** Says whether `key` is currently over the limit, without counting anything. */
	peek(key: string, at: number): RateLimitDecision;
	reset(key: string): void;
}

export const DEFAULT_LOGIN_LIMIT: RateLimitConfig = { limit: 5, windowMs: 15 * MINUTE };

interface Window {
	startedAt: number;
	hits: number;
}

/** A fixed-window limiter: at most `limit` hits per `windowMs`, counted per key. */
export function createRateLimiter(config: RateLimitConfig = DEFAULT_LOGIN_LIMIT): RateLimiter {
	const windows = new Map<string, Window>();

	function current(key: string, at: number): Window {
		const existing = windows.get(key);
		if (existing !== undefined && at - existing.startedAt < config.windowMs) {
			return existing;
		}
		return { startedAt: at, hits: 0 };
	}

	function retryAfter(window: Window, at: number): number {
		return window.startedAt + config.windowMs - at;
	}

	return {
		hit(key, at) {
			const window = current(key, at);
			window.hits += 1;
			windows.set(key, window);
			const allowed = window.hits <= config.limit;
			return { allowed, remaining: Math.max(0, config.limit - window.hits), retryAfterMs: allowed ? 0 : retryAfter(window, at) };
		},
		peek(key, at) {
			const window = current(key, at);
			// Blocked once the limit is used up: one more hit would go over.
			const allowed = window.hits < config.limit;
			return { allowed, remaining: Math.max(0, config.limit - window.hits), retryAfterMs: allowed ? 0 : retryAfter(window, at) };
		},
		reset(key) {
			windows.delete(key);
		},
	};
}

/** Looks a token up and says whose session it is. `verifySession` is the real one. */
export type VerifySession = (token: string | undefined, store: SessionStore, now: Clock) => Session | null;

export interface GuardDeps {
	sessions: SessionStore;
	limiter: RateLimiter;
	now: Clock;
	/** How a token is checked. Left out everywhere except in tests, where a stand-in keeps the test about the guard alone. */
	verify?: VerifySession;
}

export type GuardResult = { allowed: true; session: Session | null } | { allowed: false; retryAfterMs: number };

/**
 * Decides whether a request from `clientKey` may proceed. A client that is over its limit is
 * turned away before the session is even looked at.
 */
export function guardRequest(clientKey: string, token: string | undefined, deps: GuardDeps): GuardResult {
	const standing = deps.limiter.peek(clientKey, deps.now());
	if (!standing.allowed) {
		return { allowed: false, retryAfterMs: standing.retryAfterMs };
	}
	const verify = deps.verify ?? verifySession;
	try {
		return { allowed: true, session: verify(token, deps.sessions, deps.now) };
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return { allowed: true, session: null };
		}
		throw e;
	}
}
