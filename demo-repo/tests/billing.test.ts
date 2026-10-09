import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { addMoney, compareMoney, formatMoney, fromMinor, minorUnits, money, subtractMoney, toMinor } from "../src/billing/currency.js";
import { applyDiscounts, describeDiscount, discountAmount, findDiscount, validateDiscount } from "../src/billing/discount.js";
import { computeTotal, createInvoice, dueDate, isOverdue, lineTotal, markPaid, nextInvoiceNumber, subtotal, voidInvoice } from "../src/billing/invoice.js";
import { formatRate, isTaxFree, taxBreakdown, taxFor, taxRateFor } from "../src/billing/tax.js";
import { ValidationError } from "../src/util/errors.js";
import { sequentialIds } from "../src/util/ids.js";
import { DAY, fixedClock } from "../src/util/time.js";
import { makeInvoice, now, T0 } from "./support.js";

export const tests: Tests = {
	"money: amounts are whole minor units": () => {
		assert.deepEq(money(1250, "USD"), { amount: 1250, currency: "USD" });
		assert.throws(() => money(12.5, "USD"));
		assert.eq(toMinor(12.5, "USD"), 1250);
		assert.eq(fromMinor(1250, "USD"), 12.5);
		assert.eq(minorUnits("JPY"), 1);
	},
	"money: arithmetic stays within one currency": () => {
		assert.deepEq(addMoney(money(500, "EUR"), money(250, "EUR")), money(750, "EUR"));
		assert.deepEq(subtractMoney(money(500, "EUR"), money(750, "EUR")), money(-250, "EUR"));
		assert.eq(compareMoney(money(1, "GBP"), money(2, "GBP")), -1);
		assert.throws(() => addMoney(money(1, "USD"), money(1, "EUR")));
	},
	"money: formats with the currency symbol": () => {
		assert.eq(formatMoney(money(1250, "USD")), "$12.50");
		assert.eq(formatMoney(money(-300, "EUR")), "-€3.00");
		assert.eq(formatMoney(money(5, "GBP")), "£0.05");
	},
	"tax: rates come from the region": () => {
		assert.eq(taxRateFor("GB"), 2000);
		assert.eq(taxFor(10_000, 725), 725);
		assert.eq(taxFor(1999, 2000), 400);
		assert.ok(isTaxFree("US-OR"));
		assert.eq(formatRate(725), "7.25%");
		assert.eq(formatRate(2000), "20%");
	},
	"tax: breakdown names the rule": () => {
		assert.deepEq(taxBreakdown(2400, "US-CA"), { region: "US-CA", name: "California sales tax", rateBps: 725, taxable: 2400, tax: 174 });
	},
	"discounts: percent and fixed amounts": () => {
		assert.eq(discountAmount(1000, { kind: "percent", code: "TEN", percent: 10 }), 100);
		assert.eq(discountAmount(1000, { kind: "fixed", code: "FIVE", amount: 500 }), 500);
		assert.eq(discountAmount(300, { kind: "fixed", code: "FIVE", amount: 500 }), 300);
	},
	"discounts: a percentage then a fixed amount": () => {
		const discounts = [{ kind: "percent", code: "TEN", percent: 10 }, { kind: "fixed", code: "TWO", amount: 200 }] as const;
		assert.eq(applyDiscounts(1000, discounts), 300);
		assert.eq(applyDiscounts(1000, []), 0);
		assert.eq(applyDiscounts(150, [{ kind: "fixed", code: "BIG", amount: 500 }]), 150);
	},
	"discounts: definitions are validated and described": () => {
		assert.deepEq(validateDiscount({ kind: "percent", code: "TEN", percent: 10 }), []);
		assert.deepEq(validateDiscount({ kind: "percent", code: "", percent: 150 }), ["code is required", "percent must be between 1 and 100"]);
		assert.deepEq(validateDiscount({ kind: "fixed", code: "X", amount: 0 }), ["amount must be a positive whole number of minor units"]);
		assert.eq(describeDiscount({ kind: "percent", code: "TEN", percent: 10 }), "10% off (TEN)");
		assert.eq(findDiscount([{ kind: "fixed", code: "Welcome", amount: 100 }], " welcome ")?.code, "Welcome");
	},
	"invoice: line totals and subtotal": () => {
		assert.eq(lineTotal({ description: "Seat", quantity: 3, unitPrice: 1200 }), 3600);
		assert.eq(subtotal(makeInvoice().lines), 2400);
		assert.eq(subtotal([]), 0);
	},
	"invoice: total is subtotal plus tax": () => {
		assert.deepEq(computeTotal(makeInvoice()), { subtotal: 2400, discount: 0, tax: 174, total: 2574 });
		assert.deepEq(computeTotal(makeInvoice({ region: "US-OR" })), { subtotal: 2400, discount: 0, tax: 0, total: 2400 });
	},
	"invoice: tax applies after the discount": () => {
		const invoice = makeInvoice({ region: "GB", discounts: [{ kind: "percent", code: "TEN", percent: 10 }] });
		assert.deepEq(computeTotal(invoice), { subtotal: 2400, discount: 240, tax: 432, total: 2592 });
	},
	"invoice: numbers count up within a year": () => {
		assert.eq(nextInvoiceNumber(undefined, T0), "INV-2026-0001");
		assert.eq(nextInvoiceNumber("INV-2026-0041", T0), "INV-2026-0042");
		assert.eq(nextInvoiceNumber("INV-2026-0999", T0), "INV-2026-1000");
	},
	"invoice: creation validates its lines": () => {
		const ids = sequentialIds("invoice");
		const input = { userId: "usr_000001", currency: "USD", region: "US-NY", lines: [{ description: "Seat", quantity: 1, unitPrice: 1200 }] } as const;
		const invoice = createInvoice({ ...input, lines: [...input.lines] }, ids, now, "INV-2026-0007");
		assert.eq(invoice.number, "INV-2026-0008");
		assert.eq(invoice.status, "open");
		assert.throws(() => createInvoice({ ...input, lines: [] }, ids, now), ValidationError);
		assert.throws(() => createInvoice({ ...input, lines: [{ description: "Bad", quantity: 0, unitPrice: 1 }] }, ids, now), ValidationError);
	},
	"invoice: paying, voiding and overdue": () => {
		const paid = markPaid(makeInvoice(), fixedClock(T0 + DAY));
		assert.eq(paid.status, "paid");
		assert.eq(paid.paidAt, T0 + DAY);
		assert.throws(() => markPaid(paid, now), ValidationError);
		assert.throws(() => voidInvoice(paid), ValidationError);
		assert.eq(voidInvoice(makeInvoice()).status, "void");
		assert.eq(dueDate(makeInvoice()), T0 + 30 * DAY);
		assert.ok(!isOverdue(makeInvoice(), fixedClock(T0 + 30 * DAY)));
		assert.ok(isOverdue(makeInvoice(), fixedClock(T0 + 31 * DAY)));
		assert.ok(!isOverdue(paid, fixedClock(T0 + 31 * DAY)));
	},
};
