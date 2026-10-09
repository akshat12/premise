import { sortBy } from "../util/collections.js";
import { ConflictError } from "../util/errors.js";
import { normalizeEmail } from "../util/strings.js";
import { isAtLeast, type Role, ROLES } from "./roles.js";
import { displayName, type User, type UserStatus } from "./user.js";

/** An in-memory index of users, for lookup and search. */
export interface Directory {
	byId: Map<string, User>;
	byEmail: Map<string, string>;
}

export function createDirectory(users: readonly User[] = []): Directory {
	const directory: Directory = { byId: new Map(), byEmail: new Map() };
	for (const user of users) {
		addUser(directory, user);
	}
	return directory;
}

/** Adds a user. Throws ConflictError if the email is already taken by someone else. */
export function addUser(directory: Directory, user: User): void {
	const owner = directory.byEmail.get(user.email);
	if (owner !== undefined && owner !== user.id) {
		throw new ConflictError(`email ${user.email} is already registered`);
	}
	directory.byId.set(user.id, user);
	directory.byEmail.set(user.email, user.id);
}

export function removeUser(directory: Directory, id: string): boolean {
	const user = directory.byId.get(id);
	if (user === undefined) {
		return false;
	}
	directory.byId.delete(id);
	directory.byEmail.delete(user.email);
	return true;
}

export function findByEmail(directory: Directory, email: string): User | undefined {
	const id = directory.byEmail.get(normalizeEmail(email));
	return id === undefined ? undefined : directory.byId.get(id);
}

/** Users whose name or email contains `query`, ignoring case, ordered by display name. */
export function searchUsers(directory: Directory, query: string): User[] {
	const needle = query.trim().toLowerCase();
	const matches = [...directory.byId.values()].filter(
		(user) => needle === "" || user.name.toLowerCase().includes(needle) || user.email.includes(needle),
	);
	return sortBy(matches, (user) => displayName(user).toLowerCase());
}

export function listByRole(directory: Directory, minimum: Role): User[] {
	return [...directory.byId.values()].filter((user) => isAtLeast(user.roles, minimum));
}

export interface DirectoryStats {
	total: number;
	byStatus: Record<UserStatus, number>;
	byRole: Record<Role, number>;
}

export function directoryStats(directory: Directory): DirectoryStats {
	const stats: DirectoryStats = {
		total: directory.byId.size,
		byStatus: { active: 0, invited: 0, deactivated: 0 },
		byRole: { viewer: 0, member: 0, billing: 0, admin: 0 },
	};
	for (const user of directory.byId.values()) {
		stats.byStatus[user.status] += 1;
		for (const role of ROLES) {
			if (user.roles.includes(role)) {
				stats.byRole[role] += 1;
			}
		}
	}
	return stats;
}
