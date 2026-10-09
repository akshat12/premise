export type AuditEvent =
	| "session.resumed"
	| "session.expired"
	| "login.succeeded"
	| "login.failed"
	| "login.rate_limited"
	| "logout"
	| "password.changed"
	| "role.granted"
	| "role.revoked";

export interface AuditEntry {
	event: AuditEvent;
	at: number;
	/** Who or what the entry is about: a user id, an email, or a client key. */
	subject?: string;
}

export interface AuditLog {
	entries: AuditEntry[];
}

export function createAuditLog(): AuditLog {
	return { entries: [] };
}

/** Appends an entry and returns it. */
export function record(log: AuditLog, event: AuditEvent, at: number, subject?: string): AuditEntry {
	const entry: AuditEntry = subject === undefined ? { event, at } : { event, at, subject };
	log.entries.push(entry);
	return entry;
}

export function entriesFor(log: AuditLog, event: AuditEvent): AuditEntry[] {
	return log.entries.filter((entry) => entry.event === event);
}

export function entriesAbout(log: AuditLog, subject: string): AuditEntry[] {
	return log.entries.filter((entry) => entry.subject === subject);
}

export function lastEntry(log: AuditLog): AuditEntry | undefined {
	return log.entries[log.entries.length - 1];
}

/** How many entries there are of each event type. */
export function countEvents(log: AuditLog): Partial<Record<AuditEvent, number>> {
	const counts: Partial<Record<AuditEvent, number>> = {};
	for (const entry of log.entries) {
		counts[entry.event] = (counts[entry.event] ?? 0) + 1;
	}
	return counts;
}
