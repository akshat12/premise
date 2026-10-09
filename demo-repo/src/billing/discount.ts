export type Discount =
	| { kind: "percent"; code: string; percent: number }
	| { kind: "fixed"; code: string; amount: number };

export const MAX_PERCENT = 100;

export function isPercent(discount: Discount): discount is Extract<Discount, { kind: "percent" }> {
	return discount.kind === "percent";
}

/** What one discount takes off `subtotal` (minor units), never more than the subtotal itself. */
export function discountAmount(subtotal: number, discount: Discount): number {
	const raw = discount.kind === "percent" ? Math.floor((subtotal * discount.percent) / 100) : discount.amount;
	return Math.min(Math.max(0, raw), Math.max(0, subtotal));
}

/**
 * The total taken off `subtotal` by `discounts`, applied one after another in the order given.
 * Each discount works on what is left after the ones before it.
 */
export function applyDiscounts(subtotal: number, discounts: readonly Discount[]): number {
	let remaining = subtotal;
	for (const discount of discounts) {
		remaining -= discountAmount(remaining, discount);
	}
	return subtotal - remaining;
}

/** Problems with a discount's definition. An empty list means it is usable. */
export function validateDiscount(discount: Discount): string[] {
	const problems: string[] = [];
	if (discount.code.trim() === "") {
		problems.push("code is required");
	}
	if (discount.kind === "percent" && (discount.percent <= 0 || discount.percent > MAX_PERCENT)) {
		problems.push(`percent must be between 1 and ${MAX_PERCENT}`);
	}
	if (discount.kind === "fixed" && (!Number.isInteger(discount.amount) || discount.amount <= 0)) {
		problems.push("amount must be a positive whole number of minor units");
	}
	return problems;
}

export function describeDiscount(discount: Discount): string {
	return discount.kind === "percent" ? `${discount.percent}% off (${discount.code})` : `${discount.amount} off (${discount.code})`;
}

export function findDiscount(discounts: readonly Discount[], code: string): Discount | undefined {
	return discounts.find((discount) => discount.code.toLowerCase() === code.trim().toLowerCase());
}
