import type { PasswordRecord } from "../auth/password.js";
import { ValidationError } from "../util/errors.js";
import type { IdGenerator } from "../util/ids.js";
import { isBlank, normalizeEmail } from "../util/strings.js";
import type { Clock } from "../util/time.js";
import { DEFAULT_ROLE, type Role } from "./roles.js";

export type UserStatus = "active" | "invited" | "deactivated";

export interface User {
	id: string;
	email: string;
	name: string;
	status: UserStatus;
	roles: Role[];
	password: PasswordRecord;
	createdAt: number;
}

export interface NewUser {
	email: string;
	name: string;
	password: PasswordRecord;
	roles?: Role[];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
	return EMAIL_SHAPE.test(normalizeEmail(email));
}

/** Builds a new active user. Throws ValidationError for a bad email or an empty name. */
export function createUser(input: NewUser, ids: IdGenerator, now: Clock): User {
	if (!isValidEmail(input.email)) {
		throw new ValidationError("email is not valid", ["email"]);
	}
	if (isBlank(input.name)) {
		throw new ValidationError("name is required", ["name"]);
	}
	return {
		id: ids(),
		email: normalizeEmail(input.email),
		name: input.name.trim(),
		status: "active",
		roles: input.roles ?? [DEFAULT_ROLE],
		password: input.password,
		createdAt: now(),
	};
}

export function isActive(user: User): boolean {
	return user.status === "active";
}

export function deactivateUser(user: User): User {
	return { ...user, status: "deactivated" };
}

export function reactivateUser(user: User): User {
	return { ...user, status: "active" };
}

/** The name to show for a user: their name, or the part of the email before the @. */
export function displayName(user: Pick<User, "name" | "email">): string {
	return isBlank(user.name) ? (user.email.split("@")[0] ?? user.email) : user.name;
}

/** A user with the password record removed, safe to return from the API. */
export function publicUser(user: User): Omit<User, "password"> {
	const { password: _password, ...rest } = user;
	return rest;
}
