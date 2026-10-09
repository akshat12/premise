import { constantTimeEqual, saltedHash } from "../util/hash.js";
import { err, ok, type Result } from "../util/result.js";

export const TOKEN_PREFIX = "acme";

export type TokenProblem = "malformed" | "wrong_prefix" | "bad_signature";

export class TokenParseError extends Error {
	name = "TokenParseError";
	readonly problem: TokenProblem;

	constructor(problem: TokenProblem) {
		super(`invalid token: ${problem}`);
		this.problem = problem;
	}
}

function sign(sessionId: string, secret: string): string {
	return saltedHash(sessionId, secret, 4);
}

/** Wraps a session id in a signed bearer token: `acme.<sessionId>.<signature>`. */
export function issueToken(sessionId: string, secret: string): string {
	return `${TOKEN_PREFIX}.${sessionId}.${sign(sessionId, secret)}`;
}

/** Checks a bearer token's shape and signature and returns the session id inside it. */
export function parseToken(token: string, secret: string): Result<string, TokenProblem> {
	const parts = token.split(".");
	const [prefix, sessionId, signature] = parts;
	if (parts.length !== 3 || !prefix || !sessionId || !signature) {
		return err("malformed");
	}
	if (prefix !== TOKEN_PREFIX) {
		return err("wrong_prefix");
	}
	return constantTimeEqual(signature, sign(sessionId, secret)) ? ok(sessionId) : err("bad_signature");
}

/** Like parseToken, but throws TokenParseError instead of returning a Result. */
export function requireToken(token: string, secret: string): string {
	const parsed = parseToken(token, secret);
	if (!parsed.ok) {
		throw new TokenParseError(parsed.error);
	}
	return parsed.value;
}

/** A short, loggable stand-in for a token. Never log the token itself. */
export function tokenFingerprint(token: string): string {
	return saltedHash(token, "fingerprint", 1).slice(0, 8);
}

/** Reads the token out of an `Authorization: Bearer ...` header value. */
export function bearerToken(header: string | undefined): string | undefined {
	if (header === undefined) {
		return undefined;
	}
	const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
	return match?.[1];
}
