// Small source files used as test input. They are strings, not modules, so nothing imports them as code.

export const SESSION = `import type { Clock } from "../util/time.js";
import { HOUR } from "../util/time.js";

export class SessionExpiredError extends Error {
	name = "SessionExpiredError";
}

export interface Session {
	id: string;
	userId: string;
	expiresAt: number;
}

const DEFAULT_TTL = 12 * HOUR;

function isPast(at: number, now: Clock): boolean {
	return at <= now();
}

/** Returns null when no token is given. Throws when the session is expired. */
export function verifySession(
	token: string | undefined,
	sessions: Map<string, Session>,
	now: Clock,
): Session | null {
	if (token === undefined) {
		return null;
	}
	const session = sessions.get(token);
	if (session === undefined) {
		return null;
	}
	if (isPast(session.expiresAt, now)) {
		throw new SessionExpiredError("expired");
	}
	return session;
}

export function ttl(): number {
	return DEFAULT_TTL;
}

export const double = (n: number): number => {
	return n * 2;
};

export type SessionId = string;

export enum Mode {
	Strict,
	Lax,
}
`;

export const LOGIN = `import * as responses from "../api/responses.js";
import type { ApiResponse } from "../api/responses.js";
import { now as clock } from "../util/time";
import defaultLimiter from "./rate-limit.js";
import { SessionExpiredError, type Session, verifySession } from "./session.js";
import { something } from "some-package";

export interface LoginDeps {
	sessions: Map<string, Session>;
}

export function handleLogin(token: string | undefined, deps: LoginDeps): ApiResponse {
	try {
		const session = verifySession(token, deps.sessions, clock);
		return session === null ? responses.unauthorized() : responses.ok(session);
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return responses.expired();
		}
		throw e;
	}
}

export function limiter(): unknown {
	return defaultLimiter(something);
}
`;

export const EXPORT_LIST = `function alpha(): number {
	return 1;
}

const beta = 2;

function hidden(): number {
	return 3;
}

export { alpha, beta as gamma };
export { other } from "./other.js";
export default hidden;
`;
