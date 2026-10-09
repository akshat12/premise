import { sumBy } from "../util/collections.js";
import type { IdGenerator } from "../util/ids.js";

export type EntryKind = "charge" | "payment" | "refund" | "credit";

export interface LedgerEntry {
	id: string;
	accountId: string;
	kind: EntryKind;
	/** Minor units. Charges are positive; payments, refunds and credits are stored negative. */
	amount: number;
	at: number;
	memo: string;
	/** Set on the entry that cancels another one. */
	reverses?: string;
}

export interface Ledger {
	entries: LedgerEntry[];
}

export function createLedger(): Ledger {
	return { entries: [] };
}

function signed(kind: EntryKind, amount: number): number {
	return kind === "charge" ? Math.abs(amount) : -Math.abs(amount);
}

/** Records a movement on an account. `amount` is given as a positive number for every kind. */
export function postEntry(ledger: Ledger, ids: IdGenerator, accountId: string, kind: EntryKind, amount: number, at: number, memo = ""): LedgerEntry {
	const entry: LedgerEntry = { id: ids(), accountId, kind, amount: signed(kind, amount), at, memo };
	ledger.entries.push(entry);
	return entry;
}

/** What the account owes: positive means money is due, negative means the account is in credit. */
export function balanceOf(ledger: Ledger, accountId: string): number {
	return sumBy(entriesFor(ledger, accountId), (entry) => entry.amount);
}

export function entriesFor(ledger: Ledger, accountId: string): LedgerEntry[] {
	return ledger.entries.filter((entry) => entry.accountId === accountId);
}

/** Entries with `from <= at < to`. */
export function entriesBetween(ledger: Ledger, from: number, to: number): LedgerEntry[] {
	return ledger.entries.filter((entry) => entry.at >= from && entry.at < to);
}

/** Posts the opposite of an existing entry. Returns undefined if the entry is unknown or already reversed. */
export function reverseEntry(ledger: Ledger, ids: IdGenerator, entryId: string, at: number): LedgerEntry | undefined {
	const original = ledger.entries.find((entry) => entry.id === entryId);
	if (original === undefined || ledger.entries.some((entry) => entry.reverses === entryId)) {
		return undefined;
	}
	const reversal: LedgerEntry = {
		id: ids(),
		accountId: original.accountId,
		kind: original.amount > 0 ? "credit" : "charge",
		amount: -original.amount,
		at,
		memo: `Reversal of ${original.id}`,
		reverses: original.id,
	};
	ledger.entries.push(reversal);
	return reversal;
}

export function isSettled(ledger: Ledger, accountId: string): boolean {
	return balanceOf(ledger, accountId) <= 0;
}
