export type Region = "US-CA" | "US-NY" | "US-OR" | "GB" | "DE" | "JP";

export interface TaxRule {
	region: Region;
	name: string;
	/** Rate in basis points: 725 means 7.25%. Integers keep the arithmetic exact. */
	rateBps: number;
}

export const TAX_RULES: Record<Region, TaxRule> = {
	"US-CA": { region: "US-CA", name: "California sales tax", rateBps: 725 },
	"US-NY": { region: "US-NY", name: "New York sales tax", rateBps: 400 },
	"US-OR": { region: "US-OR", name: "Oregon (no sales tax)", rateBps: 0 },
	GB: { region: "GB", name: "VAT", rateBps: 2000 },
	DE: { region: "DE", name: "Umsatzsteuer", rateBps: 1900 },
	JP: { region: "JP", name: "Consumption tax", rateBps: 1000 },
};

export const BASIS_POINTS = 10_000;

export function taxRateFor(region: Region): number {
	return TAX_RULES[region].rateBps;
}

/** Tax on `amount` minor units at `rateBps`, rounded half up to a whole minor unit. */
export function taxFor(amount: number, rateBps: number): number {
	return Math.floor((amount * rateBps + BASIS_POINTS / 2) / BASIS_POINTS);
}

export function isTaxFree(region: Region): boolean {
	return TAX_RULES[region].rateBps === 0;
}

export interface TaxBreakdown {
	region: Region;
	name: string;
	rateBps: number;
	taxable: number;
	tax: number;
}

export function taxBreakdown(taxable: number, region: Region): TaxBreakdown {
	const rule = TAX_RULES[region];
	return { region, name: rule.name, rateBps: rule.rateBps, taxable, tax: taxFor(taxable, rule.rateBps) };
}

/** `7.25%` */
export function formatRate(rateBps: number): string {
	return `${(rateBps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}
