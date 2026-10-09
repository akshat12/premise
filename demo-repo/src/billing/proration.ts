import { DAY } from "../util/time.js";

export interface BillingPeriod {
	start: number;
	end: number;
}

/** A 30-day period starting at `start`. */
export function monthlyPeriod(start: number): BillingPeriod {
	return { start, end: start + 30 * DAY };
}

export function daysInPeriod(period: BillingPeriod): number {
	return Math.round((period.end - period.start) / DAY);
}

/** Whole days left in the period at `at`, counting today. Zero once the period is over. */
export function daysRemaining(period: BillingPeriod, at: number): number {
	if (at >= period.end) {
		return 0;
	}
	return Math.ceil((period.end - Math.max(at, period.start)) / DAY);
}

/** The share of `amount` that covers the rest of the period, rounded down to a whole minor unit. */
export function prorate(amount: number, period: BillingPeriod, at: number): number {
	const total = daysInPeriod(period);
	return total === 0 ? 0 : Math.floor((amount * daysRemaining(period, at)) / total);
}

/** Credit for the unused part of the old price plus the charge for the rest of the period at the new price. */
export function prorationOnChange(oldPrice: number, newPrice: number, period: BillingPeriod, at: number): { credit: number; charge: number; net: number } {
	const credit = prorate(oldPrice, period, at);
	const charge = prorate(newPrice, period, at);
	return { credit, charge, net: charge - credit };
}

export function isWithinPeriod(period: BillingPeriod, at: number): boolean {
	return at >= period.start && at < period.end;
}
