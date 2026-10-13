import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveStatus } from "./live";

/** How often the Live tab asks whether a run may start. The Worker answers from a two-second memo. */
const POLL_MS = 4000;
/** While a run is starting or going, the answer is about to change, so it is asked for more often. */
const BUSY_POLL_MS = 1500;
/** A start that has had no answer for this long is given up on, so the button does not say "Starting…" for ever. */
const START_TIMEOUT_MS = 20_000;

export interface LiveControl {
	status: LiveStatus | null;
	/** The Worker could not be asked: there is none behind this page, or the network is down. */
	unreachable: boolean;
	/** A start has been sent and not yet answered. */
	asking: boolean;
	/** When the start this page asked for was taken, on the Worker's clock. null if it has not asked, or was refused. */
	startedAt: number | null;
	/** Where the Worker keeps its repos ("artifacts" or "memory"), once it has said. */
	store: string | null;
	/** The Worker's clock, now. Countdowns are drawn against it, not against this machine's. */
	now: number;
	start: () => void;
	/** Ask again now: the board has just shown something the last answer does not know about. */
	refresh: () => void;
}

interface Answer {
	status: LiveStatus | null;
	/** Set on the answer to a start that was taken. */
	startedAt: number | null;
}

async function readAnswer(response: Response): Promise<Answer> {
	const body = (await response.json().catch(() => null)) as { status?: LiveStatus; ok?: boolean; startedAt?: number } | LiveStatus | null;
	if (body === null || typeof body !== "object") {
		return { status: null, startedAt: null };
	}
	const status = "status" in body && body.status !== undefined ? body.status : (body as LiveStatus);
	const startedAt = "ok" in body && body.ok === true && typeof body.startedAt === "number" ? body.startedAt : null;
	return { status: typeof status.now === "number" && typeof status.canStart === "boolean" ? status : null, startedAt };
}

/** Follows GET /api/live while `active`, and starts a run with POST /api/live/start. */
export function useLiveStatus(active: boolean): LiveControl {
	const [status, setStatus] = useState<LiveStatus | null>(null);
	const [unreachable, setUnreachable] = useState(false);
	const [asking, setAsking] = useState(false);
	const [startedAt, setStartedAt] = useState<number | null>(null);
	const [store, setStore] = useState<string | null>(null);
	// How far the Worker's clock is ahead of this one, from the newest answer.
	const offset = useRef(0);
	const newest = useRef(0);
	const [now, setNow] = useState(() => Date.now());

	const take = useCallback((next: LiveStatus | null) => {
		// Answers can be up to two seconds old (the Worker keeps one for a moment) and can arrive out of order.
		// One that is older than what is already on screen is dropped, so nothing steps backwards.
		if (next === null || next.now < newest.current) {
			return;
		}
		// An answer can be up to two seconds old when it arrives, so the largest lead seen is the nearest to the truth,
		// and keeping it means a countdown never steps back.
		const ahead = next.now - Date.now();
		offset.current = newest.current === 0 ? ahead : Math.max(offset.current, ahead);
		newest.current = next.now;
		setStatus(next);
		setUnreachable(false);
		setNow(Date.now() + offset.current);
	}, []);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/live", { cache: "no-store" });
			const next = response.ok ? (await readAnswer(response)).status : null;
			if (next === null) {
				setUnreachable(true);
				return;
			}
			take(next);
		} catch {
			setUnreachable(true);
		}
	}, [take]);

	const busy = status?.running ?? false;
	useEffect(() => {
		if (!active) {
			return;
		}
		void refresh();
		const poll = setInterval(() => void refresh(), busy ? BUSY_POLL_MS : POLL_MS);
		return () => clearInterval(poll);
	}, [active, busy, refresh]);
	// The countdown ticks between answers.
	useEffect(() => {
		if (!active) {
			return;
		}
		const tick = setInterval(() => setNow(Date.now() + offset.current), 1000);
		return () => clearInterval(tick);
	}, [active]);

	useEffect(() => {
		if (!active || store !== null) {
			return;
		}
		let current = true;
		fetch("/api/health")
			.then((response) => (response.ok ? response.json() : null))
			.then((body: { store?: unknown } | null) => current && typeof body?.store === "string" && setStore(body.store))
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, [active, store]);

	const start = useCallback(() => {
		setAsking(true);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), START_TIMEOUT_MS);
		fetch("/api/live/start", { method: "POST", signal: abort.signal })
			// A refusal carries the status too: it says why, and until when.
			.then(async (response) => {
				const answer = await readAnswer(response);
				setStartedAt(answer.startedAt);
				take(answer.status);
			})
			// No answer is not the same as no Worker: the next poll says which.
			.catch(() => undefined)
			.finally(() => {
				clearTimeout(timer);
				setAsking(false);
				void refresh();
			});
	}, [take, refresh]);

	return { status, unreachable, asking, startedAt, store, now, start, refresh: useCallback(() => void refresh(), [refresh]) };
}
