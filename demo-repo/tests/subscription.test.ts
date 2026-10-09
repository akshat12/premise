import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { balanceOf, createLedger, entriesBetween, isSettled, postEntry, reverseEntry } from "../src/billing/ledger.js";
import { allowsSeats, comparePlans, getPlan, hasFeature, isPlanId, isUpgrade, planPrice } from "../src/billing/plan.js";
import { daysInPeriod, daysRemaining, monthlyPeriod, prorate, prorationOnChange } from "../src/billing/proration.js";
import { cancelSubscription, changePlan, isSubscriptionActive, monthlyCharge, renew, startSubscription } from "../src/billing/subscription.js";
import { ValidationError } from "../src/util/errors.js";
import { sequentialIds } from "../src/util/ids.js";
import { DAY, fixedClock } from "../src/util/time.js";
import { now, T0 } from "./support.js";

export const tests: Tests = {
	"plans: price covers at least the included seats": () => {
		assert.eq(planPrice("free", 3), 0);
		assert.eq(planPrice("team", 2), 6000);
		assert.eq(planPrice("team", 8), 9600);
		assert.eq(getPlan("business").seatPrice, 2900);
	},
	"plans: ordering, seat limits and features": () => {
		assert.ok(isUpgrade("free", "team"));
		assert.ok(!isUpgrade("business", "team"));
		assert.eq(comparePlans("team", "team"), 0);
		assert.ok(allowsSeats("team", 50) && !allowsSeats("team", 51));
		assert.ok(allowsSeats("business", 5000) && !allowsSeats("free", 0));
		assert.ok(hasFeature("business", "sso") && !hasFeature("team", "sso"));
		assert.ok(isPlanId("team") && !isPlanId("enterprise"));
	},
	"proration: days left in a 30-day period": () => {
		const period = monthlyPeriod(T0);
		assert.eq(daysInPeriod(period), 30);
		assert.eq(daysRemaining(period, T0), 30);
		assert.eq(daysRemaining(period, T0 + 10 * DAY), 20);
		assert.eq(daysRemaining(period, T0 + 30 * DAY), 0);
		assert.eq(prorate(9000, period, T0 + 10 * DAY), 6000);
	},
	"proration: a mid-period change nets charge against credit": () => {
		assert.deepEq(prorationOnChange(6000, 9000, monthlyPeriod(T0), T0 + 15 * DAY), { credit: 3000, charge: 4500, net: 1500 });
	},
	"subscription: starting validates the seat count": () => {
		const subscription = startSubscription("acct_1", "team", 8, now);
		assert.eq(monthlyCharge(subscription), 9600);
		assert.ok(isSubscriptionActive(subscription, now));
		assert.throws(() => startSubscription("acct_1", "free", 10, now), ValidationError);
	},
	"subscription: changing plan is prorated": () => {
		const subscription = startSubscription("acct_1", "team", 5, now);
		const change = changePlan(subscription, "business", 10, fixedClock(T0 + 15 * DAY));
		assert.eq(change.subscription.plan, "business");
		assert.ok(change.upgrade);
		assert.eq(change.dueNow, 14_500 - 3000);
		assert.throws(() => changePlan(subscription, "free", 10, now), ValidationError);
	},
	"subscription: cancelling ends it at renewal": () => {
		const subscription = startSubscription("acct_1", "team", 5, now);
		const renewed = renew(subscription);
		assert.eq(renewed.period.start, subscription.period.end);
		assert.eq(renewed.status, "active");
		const cancelled = renew(cancelSubscription(subscription));
		assert.eq(cancelled.status, "cancelled");
		assert.ok(!isSubscriptionActive(cancelled, now));
	},
	"ledger: balance is charges less payments": () => {
		const ledger = createLedger();
		const ids = sequentialIds("ledgerEntry");
		postEntry(ledger, ids, "acct_1", "charge", 9600, T0, "March");
		postEntry(ledger, ids, "acct_1", "payment", 5000, T0 + DAY);
		postEntry(ledger, ids, "acct_2", "charge", 100, T0);
		assert.eq(balanceOf(ledger, "acct_1"), 4600);
		assert.ok(!isSettled(ledger, "acct_1"));
		assert.eq(entriesBetween(ledger, T0, T0 + DAY).length, 2);
	},
	"ledger: an entry can be reversed once": () => {
		const ledger = createLedger();
		const ids = sequentialIds("ledgerEntry");
		const charge = postEntry(ledger, ids, "acct_1", "charge", 9600, T0);
		const reversal = reverseEntry(ledger, ids, charge.id, T0 + DAY);
		assert.eq(reversal?.amount, -9600);
		assert.eq(reversal?.reverses, charge.id);
		assert.eq(balanceOf(ledger, "acct_1"), 0);
		assert.eq(reverseEntry(ledger, ids, charge.id, T0 + DAY), undefined);
		assert.eq(reverseEntry(ledger, ids, "led_999999", T0), undefined);
	},
};
