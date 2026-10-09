import type { Role } from "../users/roles.js";
import { PermissionError } from "../util/errors.js";

export type Permission =
	| "profile.read"
	| "profile.write"
	| "invoice.read"
	| "invoice.write"
	| "user.invite"
	| "user.deactivate"
	| "billing.manage";

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
	viewer: ["profile.read", "invoice.read"],
	member: ["profile.read", "profile.write", "invoice.read"],
	billing: ["profile.read", "profile.write", "invoice.read", "invoice.write", "billing.manage"],
	admin: ["profile.read", "profile.write", "invoice.read", "invoice.write", "user.invite", "user.deactivate", "billing.manage"],
};

export function can(role: Role, permission: Permission): boolean {
	return ROLE_PERMISSIONS[role].includes(permission);
}

/** Throws PermissionError unless `role` has `permission`. */
export function requirePermission(role: Role, permission: Permission): void {
	if (!can(role, permission)) {
		throw new PermissionError(permission);
	}
}

export function permissionsFor(role: Role): readonly Permission[] {
	return ROLE_PERMISSIONS[role];
}

/** Permissions that `to` has and `from` does not. */
export function gainedPermissions(from: Role, to: Role): Permission[] {
	return ROLE_PERMISSIONS[to].filter((permission) => !can(from, permission));
}
