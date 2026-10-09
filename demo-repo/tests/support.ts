// Shared builders for tests. Everything is deterministic: fixed clocks and sequential ids.
import { createAuditLog } from "../src/auth/audit.js";
import { createMetrics } from "../src/api/metrics.js";
import type { HandlerDeps } from "../src/api/handlers.js";
import { hashPassword } from "../src/auth/password.js";
import type { Session } from "../src/auth/session.js";
import type { Invoice } from "../src/billing/invoice.js";
import { createMemoryInvoiceStore, createMemorySessionStore, createMemoryUserStore } from "../src/store/memory-store.js";
import type { User } from "../src/users/user.js";
import { fixedClock, HOUR } from "../src/util/time.js";

/** 2026-03-01T00:00:00Z */
export const T0 = Date.UTC(2026, 2, 1);
export const now = fixedClock(T0);

export const PASSWORD = "Correct-Horse-9";

export function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: "usr_000001",
		email: "ada@example.com",
		name: "Ada Lovelace",
		status: "active",
		roles: ["member"],
		password: hashPassword(PASSWORD, "salt-1"),
		createdAt: T0,
		...overrides,
	};
}

/** A session that is valid at T0 and for an hour after. */
export function makeSession(overrides: Partial<Session> = {}): Session {
	return { id: "ses_000001", userId: "usr_000001", expiresAt: T0 + HOUR, ...overrides };
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
	return {
		id: "inv_000001",
		number: "INV-2026-0001",
		userId: "usr_000001",
		currency: "USD",
		region: "US-CA",
		lines: [{ description: "Team plan", quantity: 2, unitPrice: 1200 }],
		discounts: [],
		status: "open",
		issuedAt: T0,
		paidAt: null,
		...overrides,
	};
}

export function makeDeps(options: { users?: User[]; sessions?: Session[]; invoices?: Invoice[] } = {}): HandlerDeps {
	return {
		sessions: createMemorySessionStore(options.sessions ?? [makeSession()]),
		users: createMemoryUserStore(options.users ?? [makeUser()]),
		invoices: createMemoryInvoiceStore(options.invoices ?? [makeInvoice()]),
		profiles: new Map(),
		metrics: createMetrics(),
		now,
	};
}

export { createAuditLog };
