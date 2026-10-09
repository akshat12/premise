import type { Session } from "../auth/session.js";
import { errorCode, isAppError, RateLimitedError, ValidationError } from "../util/errors.js";
import { type Clock, formatIsoDate } from "../util/time.js";

export interface ApiResponse<T = unknown> {
	status: number;
	body: T;
	headers: Record<string, string>;
}

export interface ErrorBody {
	error: string;
	message?: string;
	fields?: readonly string[];
}

export function json<T>(status: number, body: T, headers: Record<string, string> = {}): ApiResponse<T> {
	return { status, body, headers };
}

export function ok<T>(body: T): ApiResponse<T> {
	return json(200, body);
}

export function created<T>(body: T): ApiResponse<T> {
	return json(201, body);
}

export function noContent(): ApiResponse<null> {
	return json(204, null);
}

export function badRequest(message: string, fields: readonly string[] = []): ApiResponse<ErrorBody> {
	return json(400, { error: "bad_request", message, fields });
}

/** No usable session: the caller must sign in. */
export function unauthorized(): ApiResponse<ErrorBody> {
	return json(401, { error: "unauthorized" });
}

/** The caller had a session, but it has run out. Clients use this to show "please sign in again". */
export function expired(): ApiResponse<ErrorBody> {
	return json(401, { error: "session_expired" });
}

export function forbidden(message = "forbidden"): ApiResponse<ErrorBody> {
	return json(403, { error: "forbidden", message });
}

export function notFound(what: string): ApiResponse<ErrorBody> {
	return json(404, { error: "not_found", message: `${what} not found` });
}

export function conflict(message: string): ApiResponse<ErrorBody> {
	return json(409, { error: "conflict", message });
}

export function tooManyRequests(retryAfterMs: number): ApiResponse<ErrorBody> {
	return json(429, { error: "rate_limited" }, { "retry-after": String(Math.ceil(retryAfterMs / 1000)) });
}

export function serverError(): ApiResponse<ErrorBody> {
	return json(500, { error: "internal" });
}

export function isSuccess(response: ApiResponse): boolean {
	return response.status >= 200 && response.status < 300;
}

/** Turns anything thrown by a handler into a response. Unknown errors become a 500 with no detail. */
export function fromError(error: unknown): ApiResponse<ErrorBody> {
	if (error instanceof ValidationError) {
		return badRequest(error.message, error.fields);
	}
	if (error instanceof RateLimitedError) {
		return tooManyRequests(error.retryAfterMs);
	}
	if (!isAppError(error)) {
		return serverError();
	}
	switch (errorCode(error)) {
		case "not_found":
			return json(404, { error: "not_found", message: error.message });
		case "conflict":
			return conflict(error.message);
		case "forbidden":
			return forbidden(error.message);
		default:
			return serverError();
	}
}

/** Adds the headers every authenticated response carries. */
export function withSessionHeaders<T>(response: ApiResponse<T>, session: Session, now: Clock): ApiResponse<T> {
	return {
		...response,
		headers: {
			...response.headers,
			"x-session-user": session.userId,
			"x-served-on": formatIsoDate(now()),
		},
	};
}
