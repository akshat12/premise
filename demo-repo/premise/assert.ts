// A tiny assertion library. Tests and premise assertions use it; it needs nothing from Node or the browser.

export class AssertionError extends Error {
	name = "AssertionError";
}

function show(value: unknown): string {
	try {
		return typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
	} catch {
		return String(value);
	}
}

/** Fails unless `condition` is true. */
export function ok(condition: unknown, message = "expected a truthy value"): void {
	if (!condition) {
		throw new AssertionError(message);
	}
}

/** Fails unless the two values are the same value (`Object.is`). Use deepEq for objects and arrays. */
export function eq<T>(actual: T, expected: T, message?: string): void {
	if (!Object.is(actual, expected)) {
		throw new AssertionError(`${message ? `${message}: ` : ""}expected ${show(expected)}, got ${show(actual)}`);
	}
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return false;
	}
	if (a instanceof Map && b instanceof Map) {
		return deepEqual([...a.entries()], [...b.entries()]);
	}
	const keysA = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
	const keysB = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
	if (keysA.length !== keysB.length) {
		return false;
	}
	return keysA.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Fails unless the two values have the same structure and contents. */
export function deepEq<T>(actual: T, expected: T, message?: string): void {
	if (!deepEqual(actual, expected)) {
		throw new AssertionError(`${message ? `${message}: ` : ""}expected ${show(expected)}, got ${show(actual)}`);
	}
}

/**
 * Fails unless `fn` throws. With `ErrorClass`, the thrown value must be an instance of it.
 * Returns what was thrown, so the caller can look at it further.
 */
export function throws(fn: () => unknown, ErrorClass?: new (...args: never[]) => Error, message?: string): unknown {
	let thrown: unknown;
	let didThrow = false;
	try {
		fn();
	} catch (error) {
		thrown = error;
		didThrow = true;
	}
	if (!didThrow) {
		throw new AssertionError(`${message ? `${message}: ` : ""}expected the function to throw${ErrorClass ? ` ${ErrorClass.name}` : ""}, but it returned`);
	}
	if (ErrorClass !== undefined && !(thrown instanceof ErrorClass)) {
		throw new AssertionError(`${message ? `${message}: ` : ""}expected ${ErrorClass.name}, but got ${thrown instanceof Error ? thrown.name : show(thrown)}`);
	}
	return thrown;
}

/** The shape every test file exports. */
export type Tests = Record<string, () => void | Promise<void>>;
