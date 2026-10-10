// Pure numbers behind the scale view: how fast work lands, how often Intents contend for a
// symbol, and roughly what the run costs in Artifacts operations.
import type { PremiseEvent } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import { realTimes } from "./demo";

export const BUCKET_MS = 10_000;

// Artifacts pricing, from https://developers.cloudflare.com/artifacts/platform/pricing/
// (last updated Oct 1 2026, read Oct 9 2026): operations are "repo operations, such as create,
// push, pull, and clone"; Workers Paid includes the first 10,000 a month and charges $0.15 for
// each further 1,000. Billing starts Oct 14 2026. Storage ($0.50 per GB-month after the first GB)
// is not estimated here: the demo repo is a few hundred kilobytes.
export const USD_PER_1000_OPERATIONS = 0.15;
export const INCLUDED_OPERATIONS_PER_MONTH = 10_000;

export interface ScaleStats {
	/** When each Intent landed, in ms after the run's first event (real time, with cut stretches put back). */
	landingTimes: number[];
	/** Landings in each 10 s of the run, from its start to its latest event. */
	buckets: number[];
	/** Landings divided by the minutes from the first event to the last landing. */
	landingsPerMinute: number;
	/** Claims the ledger did not grant at once: the answer was Wait, Split or Depend. */
	contention: number;
	/** How long the run has been going, in ms of real time. */
	elapsedMs: number;
}

/** Landings per `bucketMs`, covering `spanMs`. */
export function bucketCounts(times: readonly number[], spanMs: number, bucketMs = BUCKET_MS): number[] {
	const length = Math.max(1, Math.ceil(Math.max(spanMs, times.at(-1) ?? 0, 1) / bucketMs));
	const counts = Array.from({ length }, () => 0);
	for (const time of times) {
		const index = Math.min(length - 1, Math.max(0, Math.floor(time / bucketMs)));
		counts[index] = (counts[index] ?? 0) + 1;
	}
	return counts;
}

export function scaleStats(events: readonly PremiseEvent[]): ScaleStats {
	const times = realTimes(events);
	const landingTimes: number[] = [];
	let contention = 0;
	for (const [index, event] of events.entries()) {
		if (event.t === "intent.status" && event.status === "landed") {
			landingTimes.push(times[index] ?? 0);
		} else if (event.t === "claim.decision" && event.decision.kind !== "granted") {
			contention++;
		}
	}
	const elapsedMs = times.at(-1) ?? 0;
	const lastLanding = landingTimes.at(-1) ?? 0;
	return {
		landingTimes,
		buckets: bucketCounts(landingTimes, elapsedMs),
		landingsPerMinute: lastLanding > 0 ? landingTimes.length / (lastLanding / 60_000) : 0,
		contention,
		elapsedMs,
	};
}

/**
 * Artifacts operations the run made, as far as the counters show: one for each fork, and a clone
 * and a push for each commit (the Worker clones before it pushes). Reads through the binding are
 * not counted; the pricing page does not list them as operations.
 */
export function artifactsOperations(metrics: Pick<Metrics, "forksCreated" | "pushes">): number {
	return metrics.forksCreated + 2 * metrics.pushes;
}

/** What that many operations cost at the listed rate, in US dollars, before the monthly allowance. */
export function operationsCost(operations: number): number {
	return (operations / 1000) * USD_PER_1000_OPERATIONS;
}
