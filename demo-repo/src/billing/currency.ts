export type Currency = "USD" | "EUR" | "GBP" | "JPY";

export interface CurrencyInfo {
	symbol: string;
	name: string;
	/** Digits after the decimal point. Zero for currencies with no minor unit. */
	decimals: number;
}

export const CURRENCIES: Record<Currency, CurrencyInfo> = {
	USD: { symbol: "$", name: "US dollar", decimals: 2 },
	EUR: { symbol: "€", name: "Euro", decimals: 2 },
	GBP: { symbol: "£", name: "Pound sterling", decimals: 2 },
	JPY: { symbol: "¥", name: "Japanese yen", decimals: 0 },
};

/** An amount in the currency's smallest unit (cents, pence, yen). Always an integer. */
export interface Money {
	amount: number;
	currency: Currency;
}

export function money(amount: number, currency: Currency): Money {
	if (!Number.isInteger(amount)) {
		throw new Error(`money amounts are whole minor units, got ${amount}`);
	}
	return { amount, currency };
}

/** How many minor units make one major unit: 100 for USD, 1 for JPY. */
export function minorUnits(currency: Currency): number {
	return 10 ** CURRENCIES[currency].decimals;
}

export function toMinor(major: number, currency: Currency): number {
	return Math.round(major * minorUnits(currency));
}

export function fromMinor(amount: number, currency: Currency): number {
	return amount / minorUnits(currency);
}

function sameCurrency(a: Money, b: Money): void {
	if (a.currency !== b.currency) {
		throw new Error(`cannot combine ${a.currency} with ${b.currency}`);
	}
}

export function addMoney(a: Money, b: Money): Money {
	sameCurrency(a, b);
	return money(a.amount + b.amount, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
	sameCurrency(a, b);
	return money(a.amount - b.amount, a.currency);
}

export function compareMoney(a: Money, b: Money): number {
	sameCurrency(a, b);
	return Math.sign(a.amount - b.amount);
}

export function isZero(value: Money): boolean {
	return value.amount === 0;
}

/** `$12.50`, `-€3.00`. */
export function formatMoney(value: Money): string {
	const sign = value.amount < 0 ? "-" : "";
	const major = Math.abs(value.amount) / 100;
	return `${sign}${CURRENCIES[value.currency].symbol}${major.toFixed(2)}`;
}
