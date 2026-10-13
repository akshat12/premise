import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import { parseServerMessage, PING } from "../../shared/wire";
import { appendEvents, backoffMs, dueBy, httpUrl, liveUrl, OPEN_TIMEOUT_MS, PING_INTERVAL_MS, POLL_AFTER_MS, POLL_EVERY_MS, replayOffsets, restarted } from "./stream";

/** The replay looks at its clock at most once a frame. */
const FRAME_MS = 16;

export type StreamSource =
	| { kind: "live"; url: string }
	/** `until`: show no more than this many events, however far the clock has run (the replay then waits there). */
	| { kind: "replay"; events: PremiseEvent[]; speed: number; paused?: boolean; until?: number };

export interface EventStream {
	events: PremiseEvent[];
	connected: boolean;
	/** Replay only: how many recorded events are on screen. */
	position: number;
	/** Replay only: show the recording as it stood after its first `to` events, and carry on from there. */
	seek: (to: number) => void;
	/**
	 * Replay only: where the replay's clock is right now, in ms of recorded time (the scale of
	 * `replayOffsets`). It moves between events, so a view can draw time passing smoothly.
	 */
	clock: () => number;
}

/**
 * Subscribes to the event log. Live mode follows the EventHub over a WebSocket and reconnects
 * from the last seq it saw; replay mode plays a recorded log on a timer, and can be paused,
 * sped up and moved to any point.
 */
export function useEventStream(source: StreamSource): EventStream {
	const [events, setEvents] = useState<PremiseEvent[]>([]);
	const [connected, setConnected] = useState(false);

	const liveTarget = source.kind === "live" ? source.url : null;
	const replayEvents = source.kind === "replay" ? source.events : null;
	const replaySpeed = source.kind === "replay" ? source.speed : 1;
	const replayPaused = source.kind === "replay" && source.paused === true;
	const replayUntil = source.kind === "replay" ? (source.until ?? Infinity) : Infinity;

	useEffect(() => {
		if (liveTarget === null) {
			return;
		}
		let stopped = false;
		let socket: WebSocket | null = null;
		let open = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		let giveUp: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		let lastSeq = 0;
		// The time of the log's first event, as held here: how a reset that happened while nothing was listening is noticed.
		let heldFirst: number | null = null;
		// Since when there has been no open socket. Failed attempts to open one do not move it.
		let downSince = Date.now();
		setEvents([]);

		const clear = () => {
			lastSeq = 0;
			heldFirst = null;
			setEvents([]);
		};
		const take = (incoming: readonly PremiseEvent[]) => {
			if (incoming.length === 0) {
				return;
			}
			if (lastSeq === 0) {
				heldFirst = incoming.reduce((first, event) => (event.seq < first.seq ? event : first)).ts;
			}
			lastSeq = Math.max(lastSeq, ...incoming.map((event) => event.seq));
			setEvents((current) => appendEvents(current, incoming));
		};
		const json = async (url: string): Promise<PremiseEvent[] | null> => {
			const response = await fetch(url, { cache: "no-store" });
			const body: unknown = response.ok ? await response.json().catch(() => null) : null;
			return Array.isArray(body) ? (body as PremiseEvent[]) : null;
		};
		// Was the board reset while nothing was listening? Then what is held is another run's, and is dropped.
		const checkRestart = async (): Promise<boolean> => {
			const head = await json(httpUrl(liveTarget, 0, 1));
			if (stopped || head === null) {
				return false;
			}
			if (restarted(heldFirst, head[0])) {
				clear();
			}
			return true;
		};

		const connect = () => {
			const mine = new WebSocket(liveUrl(liveTarget, lastSeq));
			socket = mine;
			// A socket from an earlier connect (or an earlier visit to this tab) can still report after a newer
			// one is open. What it says is not about the newer one.
			const current = () => !stopped && socket === mine;
			clearTimeout(giveUp);
			giveUp = setTimeout(() => {
				if (current() && mine.readyState === WebSocket.CONNECTING) {
					mine.close();
				}
			}, OPEN_TIMEOUT_MS);
			mine.onopen = () => {
				if (!current()) {
					return;
				}
				const again = attempt > 0 || lastSeq > 0;
				attempt = 0;
				open = true;
				setConnected(true);
				ping = setInterval(() => mine.readyState === WebSocket.OPEN && mine.send(PING), PING_INTERVAL_MS);
				if (again) {
					// Back after a gap: the socket only sends what came after the last event held, which is nothing if the log was restarted.
					void checkRestart()
						.then(async () => {
							if (current() && lastSeq === 0) {
								take((await json(httpUrl(liveTarget, 0))) ?? []);
							}
						})
						.catch(() => undefined);
				}
			};
			mine.onmessage = (message) => {
				if (!current()) {
					return;
				}
				const parsed = typeof message.data === "string" ? parseServerMessage(message.data) : null;
				if (parsed === null) {
					return;
				}
				if (parsed.kind === "reset") {
					clear();
					return;
				}
				take(parsed.kind === "backlog" ? parsed.events : [parsed.event]);
			};
			mine.onclose = () => {
				if (!current()) {
					return;
				}
				clearInterval(ping);
				if (open) {
					downSince = Date.now();
					setConnected(false);
				}
				open = false;
				retry = setTimeout(connect, backoffMs(attempt++));
			};
			mine.onerror = () => mine.close();
		};
		connect();

		// While there is no socket, the same log is read over plain HTTP, so the board is never blank only
		// because a network does not carry WebSockets. The socket goes on being tried, and takes over when it opens.
		let asking = false;
		const poll = setInterval(() => {
			if (stopped || open || asking || Date.now() - downSince < POLL_AFTER_MS) {
				return;
			}
			asking = true;
			void (async () => {
				try {
					if (!(await checkRestart()) || stopped || open) {
						return;
					}
					const page = await json(httpUrl(liveTarget, lastSeq));
					if (page === null || stopped || open) {
						return;
					}
					take(page);
					// Following, if not by the socket.
					setConnected(true);
				} catch {
					// No Worker to ask either. The label goes on saying so.
				} finally {
					asking = false;
				}
			})();
		}, POLL_EVERY_MS);

		return () => {
			stopped = true;
			clearTimeout(retry);
			clearTimeout(giveUp);
			clearInterval(ping);
			clearInterval(poll);
			socket?.close();
			setConnected(false);
		};
	}, [liveTarget]);

	// Replay: `position` is how many of the recorded events are on screen. A timer moves it on by
	// the recorded gaps; pausing, changing speed or seeking never starts the recording again.
	const [position, setPosition] = useState(0);
	const positionRef = useRef(0);
	const loaded = useRef<PremiseEvent[] | null>(null);
	const [seeks, setSeeks] = useState(0);
	// The clock while playing: recorded time `from`, as of wall time `at`, running `speed` times as fast. Null when not playing.
	const running = useRef<{ from: number; at: number; speed: number } | null>(null);
	// Where the clock stopped at the last pause, so that resuming carries on from there and not from the last event. A seek clears it.
	const frozen = useRef<number | null>(null);
	// Set by a seek. The effect that was running writes its clock into `frozen` as it is torn down, which would
	// carry the replay straight back to where it was; the next effect drops that reading instead.
	const sought = useRef(false);
	const offsetsRef = useRef<number[]>([]);
	const untilRef = useRef(Infinity);

	useEffect(() => {
		if (replayEvents === null) {
			loaded.current = null;
			return;
		}
		if (loaded.current !== replayEvents) {
			// A different recording (or the same one, to be played again): start from nothing.
			loaded.current = replayEvents;
			positionRef.current = 0;
			setPosition(0);
			frozen.current = null;
		}
		if (sought.current) {
			frozen.current = null;
			sought.current = false;
		}
		const offsets = replayOffsets(replayEvents);
		offsetsRef.current = offsets;
		untilRef.current = replayUntil;
		setConnected(true);
		if (replayPaused) {
			return () => setConnected(false);
		}
		// The replay follows a clock: recorded time runs `replaySpeed` times as fast as the wall's,
		// starting from the last event on screen. Every event that is due is shown in one step.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const startedAt = performance.now();
		const lastShown = positionRef.current > 0 ? (offsets[positionRef.current - 1] ?? 0) : 0;
		const startedFrom = Math.max(lastShown, frozen.current ?? 0);
		running.current = { from: startedFrom, at: startedAt, speed: replaySpeed };
		const tick = () => {
			const clock = startedFrom + (performance.now() - startedAt) * replaySpeed;
			const index = Math.min(dueBy(offsets, positionRef.current, clock), Math.max(positionRef.current, replayUntil));
			if (index !== positionRef.current) {
				positionRef.current = index;
				setPosition(index);
			}
			const next = offsets[index];
			if (next !== undefined && index < replayUntil) {
				timer = setTimeout(tick, Math.max(FRAME_MS, (next - clock) / replaySpeed));
			}
		};
		timer = setTimeout(tick, 0);

		return () => {
			clearTimeout(timer);
			// Held at `until`, the clock stands at the last event shown, not wherever it ran on to.
			frozen.current = positionRef.current >= replayUntil ? (offsets[positionRef.current - 1] ?? 0) : startedFrom + (performance.now() - startedAt) * replaySpeed;
			running.current = null;
			setConnected(false);
		};
	}, [replayEvents, replaySpeed, replayPaused, replayUntil, seeks]);

	const clock = useCallback(() => {
		const offsets = offsetsRef.current;
		const end = offsets.at(-1) ?? 0;
		const lastShown = positionRef.current > 0 ? (offsets[positionRef.current - 1] ?? 0) : 0;
		const playing = running.current;
		if (positionRef.current >= untilRef.current) {
			return lastShown;
		}
		const value = playing === null ? Math.max(lastShown, frozen.current ?? 0) : playing.from + (performance.now() - playing.at) * playing.speed;
		return Math.min(end, Math.max(lastShown, value));
	}, []);

	const seek = useCallback((to: number) => {
		const length = loaded.current?.length ?? 0;
		positionRef.current = Math.min(length, Math.max(0, Math.floor(to)));
		frozen.current = null;
		sought.current = true;
		setPosition(positionRef.current);
		setSeeks((count) => count + 1);
	}, []);

	const replayed = useMemo(() => (replayEvents === null ? null : replayEvents.slice(0, position)), [replayEvents, position]);

	return { events: replayed ?? events, connected, position, seek, clock };
}
