import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { formatMoney, money } from "../src/billing/currency.js";

export const tests: Tests = {
	"yen is formatted with no fraction": () => {
		assert.eq(formatMoney(money(1200, "JPY")), "¥1200");
		assert.eq(formatMoney(money(-50, "JPY")), "-¥50");
		assert.eq(formatMoney(money(0, "JPY")), "¥0");
	},
	"two-decimal currencies are unchanged": () => {
		assert.eq(formatMoney(money(1250, "USD")), "$12.50");
		assert.eq(formatMoney(money(-300, "EUR")), "-€3.00");
		assert.eq(formatMoney(money(5, "GBP")), "£0.05");
	},
};
