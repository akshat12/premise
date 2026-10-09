export type ErrorCode = "not_found" | "validation" | "conflict" | "forbidden" | "rate_limited" | "internal";

/** Base class for errors the API layer knows how to turn into a response. */
export class AppError extends Error {
	name = "AppError";
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export class NotFoundError extends AppError {
	name = "NotFoundError";

	constructor(what: string) {
		super("not_found", `${what} not found`);
	}
}

export class ValidationError extends AppError {
	name = "ValidationError";
	readonly fields: readonly string[];

	constructor(message: string, fields: readonly string[] = []) {
		super("validation", message);
		this.fields = fields;
	}
}

export class ConflictError extends AppError {
	name = "ConflictError";

	constructor(message: string) {
		super("conflict", message);
	}
}

export class PermissionError extends AppError {
	name = "PermissionError";

	constructor(action: string) {
		super("forbidden", `not allowed to ${action}`);
	}
}

export class RateLimitedError extends AppError {
	name = "RateLimitedError";
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		super("rate_limited", "too many requests");
		this.retryAfterMs = retryAfterMs;
	}
}

export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

/** The error code for anything thrown: an AppError's own code, otherwise "internal". */
export function errorCode(error: unknown): ErrorCode {
	return isAppError(error) ? error.code : "internal";
}
