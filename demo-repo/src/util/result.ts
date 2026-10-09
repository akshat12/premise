/** The outcome of an operation that can fail without throwing. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
	return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
	return !result.ok;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
	return result.ok ? ok(fn(result.value)) : result;
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
	return result.ok ? fn(result.value) : result;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
	return result.ok ? result.value : fallback;
}

/** Returns the value, or throws if the result is an error. */
export function unwrap<T, E>(result: Result<T, E>): T {
	if (!result.ok) {
		throw new Error(`unwrap on an error result: ${String(result.error)}`);
	}
	return result.value;
}

/** All values if every result is ok, otherwise every error. */
export function collectResults<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
	const values: T[] = [];
	const errors: E[] = [];
	for (const result of results) {
		if (result.ok) {
			values.push(result.value);
		} else {
			errors.push(result.error);
		}
	}
	return errors.length > 0 ? err(errors) : ok(values);
}
