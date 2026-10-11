// Limits on the EventHub's WebSocket. Pure, so they can be tested without a Durable Object.

/**
 * The most browsers one EventHub will stream to at once. Every event is sent to every socket, so
 * without a limit anyone could slow the whole run down by opening sockets. The board is one
 * screen that a handful of people watch; 200 is far more than that and far less than trouble.
 */
export const MAX_SOCKETS = 200;

/** How long a refused browser is asked to wait before trying again. */
export const RETRY_AFTER_S = 30;

/** True when no further socket should be accepted. */
export function atCapacity(open: number, max: number = MAX_SOCKETS): boolean {
	return open >= max;
}

/** What a browser is told when it is refused. */
export function capacityMessage(max: number = MAX_SOCKETS): string {
	return `Premise is already streaming this run to ${max} viewers, which is its limit. Try again in ${RETRY_AFTER_S} seconds. GET /api/events still returns the event log.`;
}
