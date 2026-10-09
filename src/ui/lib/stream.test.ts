import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { appendEvents, backoffMs, liveUrl, replayDelays } from "./stream";

const marker = (seq: number, ts: number, label = "m"): PremiseEvent => ({ t: "demo.marker", label, seq, ts });
const status = (seq: number, ts: number): PremiseEvent => ({ t: "intent.status", id: "i00000001", status: "working", seq, ts });

describe("backoffMs", () => {
	it("goes 1, 2, 4, then stays at 8 seconds", () => {
		expect([0, 1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
		expect(backoffMs(-1)).toBe(1000);
	});
});

describe("appendEvents", () => {
	it("appends new events in seq order", () => {
		const current = [status(1, 10), status(2, 20)];
		expect(appendEvents(current, [status(4, 40), status(3, 30)]).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
	});

	it("drops events it already has (a backlog that overlaps after a reconnect)", () => {
		const current = [status(1, 10), status(2, 20)];
		expect(appendEvents(current, [status(2, 20), status(3, 30)]).map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("returns the same array when nothing is new, so React does not re-render", () => {
		const current = [status(1, 10)];
		expect(appendEvents(current, [status(1, 10)])).toBe(current);
		expect(appendEvents(current, [])).toBe(current);
	});
});

describe("liveUrl", () => {
	it("switches to the WebSocket scheme and adds since", () => {
		expect(liveUrl("https://premise.example/api/events/ws", 7)).toBe("wss://premise.example/api/events/ws?since=7");
		expect(liveUrl("http://localhost:5173/api/events/ws", 0)).toBe("ws://localhost:5173/api/events/ws?since=0");
	});

	it("resolves a relative path", () => {
		expect(liveUrl("/api/events/ws", 3)).toBe("ws://localhost/api/events/ws?since=3");
	});
});

describe("replayDelays", () => {
	it("keeps the gaps between events, divided by speed", () => {
		const events = [status(1, 1000), status(2, 1500), status(3, 3500)];
		expect(replayDelays(events, 1)).toEqual([0, 500, 2000]);
		expect(replayDelays(events, 4)).toEqual([0, 125, 500]);
	});

	it("skips the gaps on either side of a demo.marker", () => {
		const events = [status(1, 1000), marker(2, 181_000), status(3, 181_500), status(4, 182_000)];
		expect(replayDelays(events, 1)).toEqual([0, 0, 0, 500]);
	});

	it("never returns a negative delay and treats a bad speed as 1", () => {
		expect(replayDelays([status(1, 2000), status(2, 1000)], 1)).toEqual([0, 0]);
		expect(replayDelays([status(1, 0), status(2, 100)], 0)).toEqual([0, 100]);
	});

	it("handles an empty log", () => {
		expect(replayDelays([], 1)).toEqual([]);
	});
});
