/** A clock is a function returning milliseconds since the Unix epoch. Inject it; never read the system time. */
export type Clock = () => number;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A clock that always returns the same instant. */
export function fixedClock(at: number): Clock {
	return () => at;
}

/** A clock that starts at `start` and moves forward by `step` each time it is read. */
export function tickingClock(start: number, step: number = SECOND): Clock {
	let current = start - step;
	return () => {
		current += step;
		return current;
	};
}

export function addMs(at: number, ms: number): number {
	return at + ms;
}

export function isBefore(a: number, b: number): boolean {
	return a < b;
}

/** Midnight UTC at the start of the day containing `at`. */
export function startOfDay(at: number): number {
	return Math.floor(at / DAY) * DAY;
}

/** The UTC calendar year containing `at`. */
export function yearOf(at: number): number {
	return new Date(at).getUTCFullYear();
}

/** Midnight UTC on 1 January of the year containing `at`. */
export function startOfYear(at: number): number {
	return Date.UTC(yearOf(at), 0, 1);
}

/** Whole days from `from` to `to`, rounded down. Negative when `to` is earlier. */
export function daysBetween(from: number, to: number): number {
	return Math.floor((to - from) / DAY);
}

/** `YYYY-MM-DD` in UTC. */
export function formatIsoDate(at: number): string {
	const date = new Date(at);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** Keeps `at` within `[min, max]`. */
export function clampTime(at: number, min: number, max: number): number {
	return Math.min(Math.max(at, min), max);
}
