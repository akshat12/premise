export type Role = "viewer" | "member" | "billing" | "admin";

/** Every role, from least to most privileged. */
export const ROLES: readonly Role[] = ["viewer", "member", "billing", "admin"];

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, billing: 2, admin: 3 };

export const DEFAULT_ROLE: Role = "member";

export function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}

export function hasRole(roles: readonly Role[], role: Role): boolean {
	return roles.includes(role);
}

/** True when any of `roles` is `minimum` or higher. */
export function isAtLeast(roles: readonly Role[], minimum: Role): boolean {
	return roles.some((role) => ROLE_RANK[role] >= ROLE_RANK[minimum]);
}

/** The most privileged of `roles`, or undefined for an empty list. */
export function highestRole(roles: readonly Role[]): Role | undefined {
	return [...roles].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
}

/** Adds a role. The result is de-duplicated and ordered by rank. */
export function grantRole(roles: readonly Role[], role: Role): Role[] {
	return ROLES.filter((candidate) => candidate === role || roles.includes(candidate));
}

/** Removes a role. A user always keeps at least `viewer`. */
export function revokeRole(roles: readonly Role[], role: Role): Role[] {
	const remaining = roles.filter((candidate) => candidate !== role);
	return remaining.length === 0 ? ["viewer"] : remaining;
}
