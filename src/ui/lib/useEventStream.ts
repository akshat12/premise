import { useEffect, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import { parseServerMessage, PING } from "../../shared/wire";
import { appendEvents, backoffMs, liveUrl, PING_INTERVAL_MS, replayDelays } from "./stream";

export type StreamSource = { kind: "live"; url: string } | { kind: "replay"; events: PremiseEvent[]; speed: number };

/**
 * Subscribes to the event log. Live mode follows the EventHub over a WebSocket and reconnects
 * from the last seq it saw; replay mode plays a recorded log on a timer.
 */
export function useEventStream(source: StreamSource): { events: PremiseEvent[]; connected: boolean } {
	const [events, setEvents] = useState<PremiseEvent[]>([]);
	const [connected, setConnected] = useState(false);

	const liveTarget = source.kind === "live" ? source.url : null;
	const replayEvents = source.kind === "replay" ? source.events : null;
	const replaySpeed = source.kind === "replay" ? source.speed : 1;

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

	useEffect(() => {
		if (replayEvents === null) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const delays = replayDelays(replayEvents, replaySpeed);
		let index = 0;
		setEvents([]);
		setConnected(true);

		const step = () => {
			const event = replayEvents[index];
			if (event === undefined) {
				return;
			}
			index++;
			setEvents((current) => [...current, event]);
			const next = delays[index];
			if (next !== undefined) {
				timer = setTimeout(step, next);
			}
		};
		timer = setTimeout(step, delays[0] ?? 0);

		return () => {
			clearTimeout(timer);
			setConnected(false);
		};
	}, [replayEvents, replaySpeed]);

	return { events, connected };
}
