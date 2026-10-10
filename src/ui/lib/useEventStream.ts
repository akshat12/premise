import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import { parseServerMessage, PING } from "../../shared/wire";
import { appendEvents, backoffMs, dueBy, liveUrl, PING_INTERVAL_MS, replayOffsets } from "./stream";

/** The replay looks at its clock at most once a frame. */
const FRAME_MS = 16;

export type StreamSource = { kind: "live"; url: string } | { kind: "replay"; events: PremiseEvent[]; speed: number; paused?: boolean };

export interface EventStream {
	events: PremiseEvent[];
	connected: boolean;
	/** Replay only: how many recorded events are on screen. */
	position: number;
	/** Replay only: show the recording as it stood after its first `to` events, and carry on from there. */
	seek: (to: number) => void;
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

	useEffect(() => {
		if (liveTarget === null) {
			return;
		}
		let stopped = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		let attempt = 0;
		let lastSeq = 0;
		setEvents([]);

		const connect = () => {
			socket = new WebSocket(liveUrl(liveTarget, lastSeq));
			socket.onopen = () => {
				attempt = 0;
				setConnected(true);
				ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(PING), PING_INTERVAL_MS);
			};
			socket.onmessage = (message) => {
				const parsed = typeof message.data === "string" ? parseServerMessage(message.data) : null;
				if (parsed === null) {
					return;
				}
				if (parsed.kind === "reset") {
					lastSeq = 0;
					setEvents([]);
					return;
				}
				const incoming = parsed.kind === "backlog" ? parsed.events : [parsed.event];
				lastSeq = Math.max(lastSeq, ...incoming.map((event) => event.seq));
				setEvents((current) => appendEvents(current, incoming));
			};
			socket.onclose = () => {
				clearInterval(ping);
				setConnected(false);
				if (!stopped) {
					retry = setTimeout(connect, backoffMs(attempt++));
				}
			};
			socket.onerror = () => socket?.close();
		};
		connect();

		return () => {
			stopped = true;
			clearTimeout(retry);
			clearInterval(ping);
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
		}
		setConnected(true);
		if (replayPaused) {
			return () => setConnected(false);
		}
		// The replay follows a clock: recorded time runs `replaySpeed` times as fast as the wall's,
		// starting from the last event on screen. Every event that is due is shown in one step.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const offsets = replayOffsets(replayEvents);
		const startedAt = performance.now();
		const startedFrom = positionRef.current > 0 ? (offsets[positionRef.current - 1] ?? 0) : 0;
		const tick = () => {
			const clock = startedFrom + (performance.now() - startedAt) * replaySpeed;
			const index = dueBy(offsets, positionRef.current, clock);
			if (index !== positionRef.current) {
				positionRef.current = index;
				setPosition(index);
			}
			const next = offsets[index];
			if (next !== undefined) {
				timer = setTimeout(tick, Math.max(FRAME_MS, (next - clock) / replaySpeed));
			}
		};
		timer = setTimeout(tick, 0);

		return () => {
			clearTimeout(timer);
			setConnected(false);
		};
	}, [replayEvents, replaySpeed, replayPaused, seeks]);

	const seek = useCallback((to: number) => {
		const length = loaded.current?.length ?? 0;
		positionRef.current = Math.min(length, Math.max(0, Math.floor(to)));
		setPosition(positionRef.current);
		setSeeks((count) => count + 1);
	}, []);

	const replayed = useMemo(() => (replayEvents === null ? null : replayEvents.slice(0, position)), [replayEvents, position]);

	return { events: replayed ?? events, connected, position, seek };
}
