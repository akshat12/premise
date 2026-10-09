import { sumBy } from "../util/collections.js";
import { ValidationError } from "../util/errors.js";
import type { IdGenerator } from "../util/ids.js";
import { padLeft } from "../util/strings.js";
import { type Clock, DAY, yearOf } from "../util/time.js";
import type { Currency } from "./currency.js";
import { applyDiscounts, type Discount } from "./discount.js";
import { BASIS_POINTS, type Region, taxRateFor } from "./tax.js";

export interface LineItem {
	description: string;
	quantity: number;
	/** Price of one unit, in minor units. */
	unitPrice: number;
}

export type InvoiceStatus = "draft" | "open" | "paid" | "void";

export interface Invoice {
	id: string;
	/** Human-facing number, e.g. INV-2026-0042. */
	number: string;
	userId: string;
	currency: Currency;
	region: Region;
	lines: LineItem[];
	discounts: Discount[];
	status: InvoiceStatus;
	issuedAt: number;
	paidAt: number | null;
}

export interface InvoiceTotals {
	subtotal: number;
	discount: number;
	tax: number;
	total: number;
}

export const PAYMENT_TERMS_DAYS = 30;
export const INVOICE_PREFIX = "INV";

export function lineTotal(line: LineItem): number {
	return line.quantity * line.unitPrice;
}

export function subtotal(lines: readonly LineItem[]): number {
	return sumBy(lines, lineTotal);
}

/** What an invoice comes to: subtotal, less discounts, plus tax on the discounted amount. */
export function computeTotal(invoice: Pick<Invoice, "lines" | "discounts" | "region">): InvoiceTotals {
	const sub = subtotal(invoice.lines);
	const discount = applyDiscounts(sub, invoice.discounts);
	const taxable = sub - discount;
	const tax = Math.round((taxable * taxRateFor(invoice.region)) / BASIS_POINTS);
	return { subtotal: sub, discount, tax, total: taxable + tax };
}

/**
 * The number after `previous`, stamped with the year of `issuedAt`: INV-2026-0041 -> INV-2026-0042.
 * With no previous number, numbering starts at 0001.
 */
export function nextInvoiceNumber(previous: string | undefined, issuedAt: number): string {
	const lastSequence = previous === undefined ? 0 : Number(previous.split("-")[2] ?? 0);
	return `${INVOICE_PREFIX}-${yearOf(issuedAt)}-${padLeft(lastSequence + 1, 4)}`;
}

export interface NewInvoice {
	userId: string;
	currency: Currency;
	region: Region;
	lines: LineItem[];
	discounts?: Discount[];
}

/** Builds an open invoice. Throws ValidationError if it has no lines or a line is malformed. */
export function createInvoice(input: NewInvoice, ids: IdGenerator, now: Clock, previousNumber?: string): Invoice {
	if (input.lines.length === 0) {
		throw new ValidationError("an invoice needs at least one line", ["lines"]);
	}
	for (const line of input.lines) {
		if (!Number.isInteger(line.quantity) || line.quantity <= 0 || !Number.isInteger(line.unitPrice) || line.unitPrice < 0) {
			throw new ValidationError(`bad line item: ${line.description}`, ["lines"]);
		}
	}
	const issuedAt = now();
	return {
		id: ids(),
		number: nextInvoiceNumber(previousNumber, issuedAt),
		userId: input.userId,
		currency: input.currency,
		region: input.region,
		lines: input.lines,
		discounts: input.discounts ?? [],
		status: "open",
		issuedAt,
		paidAt: null,
	};
}

export function markPaid(invoice: Invoice, now: Clock): Invoice {
	if (invoice.status !== "open") {
		throw new ValidationError(`cannot pay an invoice that is ${invoice.status}`);
	}
	return { ...invoice, status: "paid", paidAt: now() };
}

export function voidInvoice(invoice: Invoice): Invoice {
	if (invoice.status === "paid") {
		throw new ValidationError("cannot void a paid invoice");
	}
	return { ...invoice, status: "void" };
}

export function dueDate(invoice: Pick<Invoice, "issuedAt">, termsDays: number = PAYMENT_TERMS_DAYS): number {
	return invoice.issuedAt + termsDays * DAY;
}

export function isOverdue(invoice: Invoice, now: Clock, termsDays: number = PAYMENT_TERMS_DAYS): boolean {
	return invoice.status === "open" && now() > dueDate(invoice, termsDays);
}
