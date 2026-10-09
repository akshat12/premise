import type { Currency } from "./currency.js";

export type PlanId = "free" | "team" | "business";

export interface Plan {
	id: PlanId;
	name: string;
	/** Monthly price per seat, in USD cents. */
	seatPrice: number;
	seatsIncluded: number;
	maxSeats: number | null;
	features: readonly string[];
}

export const PLANS: Record<PlanId, Plan> = {
	free: { id: "free", name: "Free", seatPrice: 0, seatsIncluded: 3, maxSeats: 3, features: ["invoices"] },
	team: { id: "team", name: "Team", seatPrice: 1200, seatsIncluded: 5, maxSeats: 50, features: ["invoices", "roles", "audit"] },
	business: { id: "business", name: "Business", seatPrice: 2900, seatsIncluded: 10, maxSeats: null, features: ["invoices", "roles", "audit", "sso"] },
};

export const PLAN_ORDER: readonly PlanId[] = ["free", "team", "business"];
export const PLAN_CURRENCY: Currency = "USD";

export function getPlan(id: PlanId): Plan {
	return PLANS[id];
}

export function isPlanId(value: string): value is PlanId {
	return (PLAN_ORDER as readonly string[]).includes(value);
}

/** Monthly price for `seats` seats: seats beyond the included ones are charged at the seat price. */
export function planPrice(id: PlanId, seats: number): number {
	const plan = PLANS[id];
	return Math.max(0, seats - plan.seatsIncluded) * plan.seatPrice + plan.seatsIncluded * plan.seatPrice;
}

export function comparePlans(a: PlanId, b: PlanId): number {
	return PLAN_ORDER.indexOf(a) - PLAN_ORDER.indexOf(b);
}

export function isUpgrade(from: PlanId, to: PlanId): boolean {
	return comparePlans(to, from) > 0;
}

export function allowsSeats(id: PlanId, seats: number): boolean {
	const max = PLANS[id].maxSeats;
	return seats >= 1 && (max === null || seats <= max);
}

export function hasFeature(id: PlanId, feature: string): boolean {
	return PLANS[id].features.includes(feature);
}
