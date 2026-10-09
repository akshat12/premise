import * as responses from "../api/responses.js";
import type { ApiResponse } from "../api/responses.js";
import type { UserRepository } from "../store/repo.js";
import type { IdGenerator } from "../util/ids.js";
import { normalizeEmail } from "../util/strings.js";
import type { Clock } from "../util/time.js";
import { type AuditLog, record } from "./audit.js";
import { verifyPassword } from "./password.js";
import type { RateLimiter } from "./rate-limit.js";
import { createSession, revokeSession, SessionExpiredError, type SessionStore, verifySession } from "./session.js";

export interface LoginDeps {
	store: SessionStore;
	audit: AuditLog;
	now: Clock;
}

/** Resumes a login from a session token: who the caller is, or why we cannot say. */
export function handleLogin(token: string | undefined, deps: LoginDeps): ApiResponse {
	try {
		const session = verifySession(token, deps.store, deps.now);
		if (session === null) {
			return responses.unauthorized();
		}
		record(deps.audit, "session.resumed", deps.now(), session.userId);
		return responses.ok({ userId: session.userId, expiresAt: session.expiresAt });
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return responses.expired();
		}
		throw e;
	}
}

export interface PasswordLoginDeps extends LoginDeps {
	users: UserRepository;
	limiter: RateLimiter;
	ids: IdGenerator;
}

/** Signs a user in with email and password, and starts a session. */
export function startLogin(email: string, password: string, deps: PasswordLoginDeps): ApiResponse {
	const address = normalizeEmail(email);
	const attempt = deps.limiter.hit(address, deps.now());
	if (!attempt.allowed) {
		record(deps.audit, "login.rate_limited", deps.now(), address);
		return responses.tooManyRequests(attempt.retryAfterMs);
	}

	const user = deps.users.findByEmail(address);
	if (user === undefined || user.status !== "active" || !verifyPassword(password, user.password)) {
		record(deps.audit, "login.failed", deps.now(), address);
		return responses.unauthorized();
	}

	deps.limiter.reset(address);
	const session = createSession(user.id, deps.store, deps.now, deps.ids);
	record(deps.audit, "login.succeeded", deps.now(), user.id);
	return responses.created({ token: session.id, userId: user.id, expiresAt: session.expiresAt });
}

/** Ends the session behind `token`. Succeeds whether or not there was one. */
export function logout(token: string | undefined, deps: LoginDeps): ApiResponse {
	if (token !== undefined && revokeSession(token, deps.store)) {
		record(deps.audit, "logout", deps.now());
	}
	return responses.ok({ signedOut: true });
}
