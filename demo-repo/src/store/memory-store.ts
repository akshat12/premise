import type { Session, SessionStore } from "../auth/session.js";
import type { Invoice } from "../billing/invoice.js";
import type { User } from "../users/user.js";
import { normalizeEmail } from "../util/strings.js";
import type { InvoiceRepository, Repository, UserRepository } from "./repo.js";

/** A Map-backed table. Items are copied on the way in and out, so callers cannot mutate stored state. */
export class MemoryTable<T extends { id: string }> implements Repository<T> {
	private rows = new Map<string, T>();

	constructor(initial: readonly T[] = []) {
		for (const item of initial) {
			this.put(item);
		}
	}

	get(id: string): T | undefined {
		const row = this.rows.get(id);
		return row === undefined ? undefined : { ...row };
	}

	put(item: T): void {
		this.rows.set(item.id, { ...item });
	}

	delete(id: string): boolean {
		return this.rows.delete(id);
	}

	all(): T[] {
		return [...this.rows.values()].map((row) => ({ ...row }));
	}

	get size(): number {
		return this.rows.size;
	}
}

export function createMemorySessionStore(sessions: readonly Session[] = []): SessionStore {
	return new MemoryTable<Session>(sessions);
}

export function createMemoryUserStore(users: readonly User[] = []): UserRepository {
	const table = new MemoryTable<User>(users);
	return {
		get: (id) => table.get(id),
		put: (user) => table.put(user),
		delete: (id) => table.delete(id),
		all: () => table.all(),
		findByEmail: (email) => table.all().find((user) => user.email === normalizeEmail(email)),
	};
}

export function createMemoryInvoiceStore(invoices: readonly Invoice[] = []): InvoiceRepository {
	const table = new MemoryTable<Invoice>(invoices);
	return {
		get: (id) => table.get(id),
		put: (invoice) => table.put(invoice),
		delete: (id) => table.delete(id),
		all: () => table.all(),
		forUser: (userId) => table.all().filter((invoice) => invoice.userId === userId),
	};
}
