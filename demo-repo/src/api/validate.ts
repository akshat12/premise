import { isValidEmail } from "../users/user.js";
import { visibleLength } from "../util/strings.js";

export interface FieldError {
	field: string;
	message: string;
}

/** Checks one value. Returns a message when it is wrong, or null when it is fine. */
export type Validator = (value: unknown) => string | null;

export const required: Validator = (value) => (value === undefined || value === null || value === "" ? "is required" : null);

export const isString: Validator = (value) => (value === undefined || typeof value === "string" ? null : "must be a string");

export const isInteger: Validator = (value) => (value === undefined || Number.isInteger(value) ? null : "must be a whole number");

export const isEmail: Validator = (value) => (value === undefined || (typeof value === "string" && isValidEmail(value)) ? null : "must be an email address");

export function minLength(min: number): Validator {
	return (value) => (typeof value === "string" && visibleLength(value) < min ? `must be at least ${min} characters` : null);
}

export function maxLength(max: number): Validator {
	return (value) => (typeof value === "string" && visibleLength(value) > max ? `must be at most ${max} characters` : null);
}

export function oneOf(allowed: readonly string[]): Validator {
	return (value) => (value === undefined || (typeof value === "string" && allowed.includes(value)) ? null : `must be one of ${allowed.join(", ")}`);
}

export type Schema = Record<string, readonly Validator[]>;

/** Runs every validator for every field. Each field reports at most its first problem. */
export function validateObject(input: Record<string, unknown>, schema: Schema): FieldError[] {
	const errors: FieldError[] = [];
	for (const [field, validators] of Object.entries(schema)) {
		for (const validator of validators) {
			const message = validator(input[field]);
			if (message !== null) {
				errors.push({ field, message });
				break;
			}
		}
	}
	return errors;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fieldNames(errors: readonly FieldError[]): string[] {
	return errors.map((error) => error.field);
}
