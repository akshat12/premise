// The WebSocket protocol between the EventHub and the UI, plus small validators.
import type { PremiseEvent, PremiseEventBody } from "./events";

/** Every `t` value in PremiseEventBody. Keep in step with events.ts (the `satisfies` below enforces it one way). */
export const EVENT_TYPES = [
	"intent.created",
	"intent.status",
	"intent.why",
	"premise.recorded",
	"premise.broken",
	"claim.decision",
	"push.checked",
	"gate.result",
	"trunk.advanced",
	"rederive.race",
	"human.needed",
	"human.resolved",
	"metrics",
	"artifacts",
	"demo.marker",
] as const satisfies readonly PremiseEventBody["t"][];

// Compile-time check in the other direction: fails if events.ts gains a type that is missing above.
type Missing = Exclude<PremiseEventBody["t"], (typeof EVENT_TYPES)[number]>;
const _exhaustive: Missing extends never ? true : never = true;
void _exhaustive;

/** What the hub sends over the socket: one event, a batch of past events, or a notice that the log was cleared. */
export type ServerMessage = { kind: "event"; event: PremiseEvent } | { kind: "backlog"; events: PremiseEvent[] } | { kind: "reset" };

export const PING = "ping";
export const PONG = "pong";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow check that a JSON value looks like an event body: an object whose `t` is a known type. */
export function isEventBody(value: unknown): value is PremiseEventBody {
	return isRecord(value) && typeof value.t === "string" && (EVENT_TYPES as readonly string[]).includes(value.t);
}

function isEvent(value: unknown): value is PremiseEvent {
	return isEventBody(value) && typeof (value as { seq?: unknown }).seq === "number" && typeof (value as { ts?: unknown }).ts === "number";
}

/**
 * Decodes one socket frame. On the wire a single event is the bare event object, a backlog is
 * `{ "backlog": [...] }`, and a reset is `{ "reset": true }`. Returns null for anything else,
 * including "pong".
 */
export function parseServerMessage(data: string): ServerMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	if (!isRecord(value)) {
		return null;
	}
	if (Array.isArray(value.backlog)) {
		return { kind: "backlog", events: value.backlog.filter(isEvent) };
	}
	if (value.reset === true) {
		return { kind: "reset" };
	}
	return isEvent(value) ? { kind: "event", event: value } : null;
}

/** Reads `?since=N` (default 0). Anything that is not a non-negative integer counts as 0. */
export function parseSince(url: URL): number {
	const raw = url.searchParams.get("since");
	const value = raw === null ? 0 : Number(raw);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}
