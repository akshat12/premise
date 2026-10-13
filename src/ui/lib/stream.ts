// Pure helpers behind useEventStream, kept separate so they can be unit-tested without a DOM.
import type { PremiseEvent } from "../../shared/events";

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000];
export const PING_INTERVAL_MS = 20_000;

/** Reconnect delay for the nth consecutive failure (0-based): 1, 2, 4, then 8 seconds at most. */
export function backoffMs(attempt: number): number {
	const index = Math.min(Math.max(0, Math.floor(attempt)), BACKOFF_STEPS_MS.length - 1);
	return BACKOFF_STEPS_MS[index] ?? 8000;
}

/** Adds newly arrived events to the list, dropping any we already have. Result is ordered by seq. */
export function appendEvents(current: readonly PremiseEvent[], incoming: readonly PremiseEvent[]): PremiseEvent[] {
	const lastSeq = current.at(-1)?.seq ?? 0;
	const fresh = incoming.filter((event) => event.seq > lastSeq).sort((a, b) => a.seq - b.seq);
	return fresh.length === 0 ? (current as PremiseEvent[]) : [...current, ...fresh];
}

/** A socket that has not opened in this long is given up on and tried again. Some networks never answer the upgrade. */
export const OPEN_TIMEOUT_MS = 5000;
/** With no socket for this long, the log is asked for over plain HTTP instead, this often, until a socket opens. */
export const POLL_AFTER_MS = 2500;
export const POLL_EVERY_MS = 2500;

/**
 * The same log over plain HTTP: `/api/events/ws` is the socket, `/api/events` the JSON. Used while
 * no socket is open, so the board still shows where WebSockets are blocked.
 */
export function httpUrl(base: string, since: number, limit?: number): string {
	const url = new URL(base, typeof location === "undefined" ? "http://localhost" : location.href);
	url.pathname = url.pathname.replace(/\/ws$/, "");
	url.searchParams.set("since", String(since));
	if (limit !== undefined) {
		url.searchParams.set("limit", String(limit));
	}
	return url.toString();
}

/**
 * True when the log on the Worker is not the one this page is holding: the board was reset while
 * nothing was listening. `heldFirst` is the time of the first event held, null if none is;
 * `first` is the log's first event now, undefined if the log is empty. A reset starts the
 * numbering again, so asking for "everything after the last one I have" would return nothing.
 */
export function restarted(heldFirst: number | null, first: Pick<PremiseEvent, "ts"> | undefined): boolean {
	return heldFirst !== null && (first === undefined || first.ts !== heldFirst);
}

/** `ws(s)://host/path?since=N` for the page the UI is served from. */
export function liveUrl(base: string, since: number): string {
	const url = new URL(base, typeof location === "undefined" ? "http://localhost" : location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
	url.searchParams.set("since", String(since));
	return url.toString();
}

/**
 * How long to wait before showing each event in a replay: the gap between its `ts` and the
 * previous one, divided by `speed`. A `demo.marker` stands for time that was cut out of the
 * recording, so the gap before one is skipped. The gap after it is played as recorded: that is
 * the short pause the cut was reduced to, with the marker on screen.
 */
export function replayDelays(events: readonly PremiseEvent[], speed: number): number[] {
	const rate = speed > 0 ? speed : 1;
	return events.map((event, index) => {
		const previous = events[index - 1];
		if (previous === undefined || event.t === "demo.marker") {
			return 0;
		}
		return Math.max(0, event.ts - previous.ts) / rate;
	});
}

/**
 * When each event of a replay is due, in ms of recorded time after the start (at 1×): the
 * running total of `replayDelays`. The player follows a clock against these, so a burst of
 * events is shown together and a slow frame never makes the replay fall behind.
 */
export function replayOffsets(events: readonly PremiseEvent[]): number[] {
	let total = 0;
	return replayDelays(events, 1).map((delay) => (total += delay));
}

/** How many events are due once the replay's clock reads `clock` ms, given that `from` are already shown. */
export function dueBy(offsets: readonly number[], from: number, clock: number): number {
	let index = Math.max(0, from);
	while (index < offsets.length && (offsets[index] ?? Infinity) <= clock) {
		index++;
	}
	return index;
}

/**
 * The replay's clock runs on `replayOffsets`, which skips the pause before a marker; a view that
 * draws time uses the events' own timestamps. This turns a clock reading into that scale, by
 * sliding between the last event shown and the next one due. Pure.
 *   offsets   `replayOffsets(events)`
 *   times     each event's time on the view's scale (ms after the first event)
 *   position  how many events are shown
 */
export function timeAtClock(offsets: readonly number[], times: readonly number[], position: number, clock: number): number {
	if (times.length === 0) {
		return 0;
	}
	if (position <= 0) {
		return times[0] ?? 0;
	}
	const shown = Math.min(position, times.length) - 1;
	const next = shown + 1;
	const from = times[shown] ?? 0;
	if (next >= times.length) {
		return from;
	}
	const gap = (offsets[next] ?? 0) - (offsets[shown] ?? 0);
	const share = gap <= 0 ? 0 : Math.min(1, Math.max(0, (clock - (offsets[shown] ?? 0)) / gap));
	return from + share * ((times[next] ?? from) - from);
}
