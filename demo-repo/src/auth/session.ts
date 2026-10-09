import type { IdGenerator } from "../util/ids.js";
import { type Clock, HOUR } from "../util/time.js";

export class SessionExpiredError extends Error {
	name = "SessionExpiredError";
}

export interface Session {
	id: string;
	userId: string;
	expiresAt: number;
}

/** Where sessions live. The session id doubles as the bearer token. */
export interface SessionStore {
	get(id: string): Session | undefined;
	put(session: Session): void;
	delete(id: string): boolean;
}

export const DEFAULT_SESSION_TTL_MS = 12 * HOUR;

export function isExpired(session: Session, now: Clock): boolean {
	return session.expiresAt <= now();
}

/** Returns null when no token is given. Throws SessionExpiredError when the session is expired. */
export function verifySession(token: string | undefined, store: SessionStore, now: () => number): Session | null {
	if (token === undefined || token === "") {
		return null;
	}
	const session = store.get(token);
	if (session === undefined) {
		return null;
	}
	if (isExpired(session, now)) {
		throw new SessionExpiredError(`session ${session.id} expired`);
	}
	return session;
}

/** Starts a session for a user and stores it. */
export function createSession(
	userId: string,
	store: SessionStore,
	now: Clock,
	ids: IdGenerator,
	ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Session {
	const session: Session = { id: ids(), userId, expiresAt: now() + ttlMs };
	store.put(session);
	return session;
}

/** Milliseconds until the session expires. Zero once it has. */
export function sessionTtl(session: Session, now: Clock): number {
	return Math.max(0, session.expiresAt - now());
}

/** Pushes the expiry out by `ttlMs` from now and stores the result. */
export function extendSession(session: Session, store: SessionStore, now: Clock, ttlMs: number = DEFAULT_SESSION_TTL_MS): Session {
	const extended: Session = { ...session, expiresAt: now() + ttlMs };
	store.put(extended);
	return extended;
}

/** Ends a session. Returns false if there was none. */
export function revokeSession(token: string, store: SessionStore): boolean {
	return store.delete(token);
}
