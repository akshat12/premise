import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { appendEvents, backoffMs, dueBy, httpUrl, liveUrl, replayDelays, replayOffsets, restarted, timeAtClock } from "./stream";

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

	it("skips the gap before a demo.marker and plays the pause after it", () => {
		// The marker stands for the three minutes before it. What follows it is the pause that was kept.
		const events = [status(1, 1000), marker(2, 181_000), status(3, 181_500), status(4, 182_000)];
		expect(replayDelays(events, 1)).toEqual([0, 0, 500, 500]);
		expect(replayDelays(events, 2)).toEqual([0, 0, 250, 250]);
	});

	it("never returns a negative delay and treats a bad speed as 1", () => {
		expect(replayDelays([status(1, 2000), status(2, 1000)], 1)).toEqual([0, 0]);
		expect(replayDelays([status(1, 0), status(2, 100)], 0)).toEqual([0, 100]);
	});

	it("handles an empty log", () => {
		expect(replayDelays([], 1)).toEqual([]);
	});
});

describe("replayOffsets and dueBy", () => {
	const events = [status(1, 1000), status(2, 1500), status(3, 1500), marker(4, 181_000), status(5, 182_000)];

	it("gives each event's due time on the recording's own clock, with the cut before a marker left out", () => {
		expect(replayOffsets(events)).toEqual([0, 500, 500, 500, 1500]);
		expect(replayOffsets([])).toEqual([]);
	});

	it("shows everything that is due, however many that is", () => {
		const offsets = replayOffsets(events);
		expect(dueBy(offsets, 0, 0)).toBe(1);
		expect(dueBy(offsets, 1, 499)).toBe(1);
		expect(dueBy(offsets, 1, 500)).toBe(4);
		expect(dueBy(offsets, 4, 10_000)).toBe(5);
	});

	it("never goes back, even if the clock is behind what is shown", () => {
		expect(dueBy(replayOffsets(events), 4, 0)).toBe(4);
	});
});

describe("timeAtClock", () => {
	// Three events. The replay skips part of the pause before the last one, so its clock and the events' own times differ.
	const offsets = [0, 1000, 1500];
	const times = [0, 1000, 5000];

	it("slides between the last event shown and the next one due", () => {
		expect(timeAtClock(offsets, times, 1, 0)).toBe(0);
		expect(timeAtClock(offsets, times, 1, 500)).toBe(500);
		expect(timeAtClock(offsets, times, 2, 1000)).toBe(1000);
		expect(timeAtClock(offsets, times, 2, 1250)).toBe(3000);
	});

	it("never runs past the next event or back before the last one", () => {
		expect(timeAtClock(offsets, times, 2, 9999)).toBe(5000);
		expect(timeAtClock(offsets, times, 2, 0)).toBe(1000);
	});

	it("stays at the end once everything is shown, and at the start before anything is", () => {
		expect(timeAtClock(offsets, times, 3, 99999)).toBe(5000);
		expect(timeAtClock(offsets, times, 0, 700)).toBe(0);
		expect(timeAtClock([], [], 0, 10)).toBe(0);
	});
});


describe("httpUrl", () => {
	it("is the socket's address without /ws, over http, with the place to read from", () => {
		expect(httpUrl("/api/events/ws", 0)).toBe("http://localhost/api/events?since=0");
		expect(httpUrl("/api/events/ws", 976)).toBe("http://localhost/api/events?since=976");
		expect(httpUrl("/api/events/ws", 0, 1)).toBe("http://localhost/api/events?since=0&limit=1");
		expect(httpUrl("https://premise.example/api/events/ws", 12)).toBe("https://premise.example/api/events?since=12");
	});
});

describe("restarted", () => {
	it("says the log is another run's when its first event is not the one held", () => {
		expect(restarted(1000, { ts: 2000 })).toBe(true);
		expect(restarted(1000, { ts: 1000 })).toBe(false);
	});

	it("says so when the log is now empty and something is held", () => {
		expect(restarted(1000, undefined)).toBe(true);
	});

	it("has nothing to say when nothing is held yet", () => {
		expect(restarted(null, { ts: 2000 })).toBe(false);
		expect(restarted(null, undefined)).toBe(false);
	});
});
