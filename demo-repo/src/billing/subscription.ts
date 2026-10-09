import { ValidationError } from "../util/errors.js";
import type { Clock } from "../util/time.js";
import { allowsSeats, isUpgrade, type PlanId, planPrice } from "./plan.js";
import { type BillingPeriod, isWithinPeriod, monthlyPeriod, prorationOnChange } from "./proration.js";

export type SubscriptionStatus = "active" | "cancelled" | "past_due";

export interface Subscription {
	accountId: string;
	plan: PlanId;
	seats: number;
	status: SubscriptionStatus;
	period: BillingPeriod;
	/** When set, the subscription ends at the close of the current period. */
	cancelAt: number | null;
}

export function startSubscription(accountId: string, plan: PlanId, seats: number, now: Clock): Subscription {
	if (!allowsSeats(plan, seats)) {
		throw new ValidationError(`plan ${plan} does not allow ${seats} seats`, ["seats"]);
	}
	return { accountId, plan, seats, status: "active", period: monthlyPeriod(now()), cancelAt: null };
}

export function monthlyCharge(subscription: Pick<Subscription, "plan" | "seats">): number {
	return planPrice(subscription.plan, subscription.seats);
}

export interface PlanChange {
	subscription: Subscription;
	/** Minor units to charge now (positive) or credit (negative). */
	dueNow: number;
	upgrade: boolean;
}

/** Moves a subscription to another plan or seat count, prorated over what is left of the period. */
export function changePlan(subscription: Subscription, plan: PlanId, seats: number, now: Clock): PlanChange {
	if (subscription.status !== "active") {
		throw new ValidationError(`cannot change a subscription that is ${subscription.status}`);
	}
	if (!allowsSeats(plan, seats)) {
		throw new ValidationError(`plan ${plan} does not allow ${seats} seats`, ["seats"]);
	}
	const proration = prorationOnChange(monthlyCharge(subscription), planPrice(plan, seats), subscription.period, now());
	return {
		subscription: { ...subscription, plan, seats },
		dueNow: proration.net,
		upgrade: isUpgrade(subscription.plan, plan),
	};
}

/** Schedules cancellation for the end of the current period. */
export function cancelSubscription(subscription: Subscription): Subscription {
	return { ...subscription, cancelAt: subscription.period.end };
}

export function isSubscriptionActive(subscription: Subscription, now: Clock): boolean {
	return subscription.status === "active" && isWithinPeriod(subscription.period, now());
}

/** Rolls the subscription into its next period, or ends it if cancellation was scheduled. */
export function renew(subscription: Subscription): Subscription {
	if (subscription.cancelAt !== null) {
		return { ...subscription, status: "cancelled" };
	}
	return { ...subscription, period: monthlyPeriod(subscription.period.end) };
}
