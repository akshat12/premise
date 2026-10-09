export interface Metrics {
	requests: number;
	/** Requests that arrived with a session that had run out. */
	sessionsExpired: number;
	unauthorized: number;
	errors: number;
	byRoute: Record<string, number>;
}

export type Counter = Exclude<keyof Metrics, "byRoute">;

export function createMetrics(): Metrics {
	return { requests: 0, sessionsExpired: 0, unauthorized: 0, errors: 0, byRoute: {} };
}

export function increment(metrics: Metrics, counter: Counter, by = 1): void {
	metrics[counter] += by;
}

export function countRoute(metrics: Metrics, route: string): void {
	metrics.byRoute[route] = (metrics.byRoute[route] ?? 0) + 1;
}

/** A copy that will not change as more requests arrive. */
export function snapshotMetrics(metrics: Metrics): Metrics {
	return { ...metrics, byRoute: { ...metrics.byRoute } };
}

export function resetMetrics(metrics: Metrics): void {
	Object.assign(metrics, createMetrics());
}

/** Share of requests that ended in an error, from 0 to 1. Zero when there were no requests. */
export function errorRate(metrics: Metrics): number {
	return metrics.requests === 0 ? 0 : metrics.errors / metrics.requests;
}
