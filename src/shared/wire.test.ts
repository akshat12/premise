import { describe, expect, it } from "vitest";
import { EVENT_TYPES, isEventBody, parseServerMessage, parseSince } from "./wire";

const event = { t: "demo.marker", label: "hi", seq: 3, ts: 1000 };

describe("isEventBody", () => {
	it("accepts every known event type", () => {
		for (const t of EVENT_TYPES) {
			expect(isEventBody({ t })).toBe(true);
		}
		expect(EVENT_TYPES).toHaveLength(15);
	});

	it("rejects unknown types and non-objects", () => {
		for (const bad of [{ t: "nope" }, { label: "x" }, { t: 1 }, null, "demo.marker", [], 42]) {
			expect(isEventBody(bad)).toBe(false);
		}
	});
});

describe("parseServerMessage", () => {
	it("decodes a single event", () => {
		expect(parseServerMessage(JSON.stringify(event))).toEqual({ kind: "event", event });
	});

	it("decodes a backlog and drops malformed entries", () => {
		const frame = JSON.stringify({ backlog: [event, { t: "demo.marker", label: "no seq" }, "junk"] });
		expect(parseServerMessage(frame)).toEqual({ kind: "backlog", events: [event] });
		expect(parseServerMessage('{"backlog":[]}')).toEqual({ kind: "backlog", events: [] });
	});

	it("decodes a reset", () => {
		expect(parseServerMessage('{"reset":true}')).toEqual({ kind: "reset" });
	});

	it("returns null for pong, bad JSON and unknown shapes", () => {
		for (const frame of ["pong", "{", "[]", "null", '{"t":"nope","seq":1,"ts":1}', '{"t":"demo.marker","label":"x"}']) {
			expect(parseServerMessage(frame)).toBeNull();
		}
	});
});

describe("parseSince", () => {
	it("reads a non-negative integer and defaults to 0", () => {
		expect(parseSince(new URL("http://x/api/events?since=42"))).toBe(42);
		expect(parseSince(new URL("http://x/api/events"))).toBe(0);
		for (const bad of ["-1", "abc", "1.5", "", "Infinity"]) {
			expect(parseSince(new URL(`http://x/api/events?since=${bad}`))).toBe(0);
		}
	});
});
