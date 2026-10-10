import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { compressRun, formatCut, momentKind, nextStop, parseCut, realTimes } from "./demo";
import { replayDelays } from "./stream";

const status = (ts: number, id = "i00000001", state: "working" | "stale" | "landed" = "working"): PremiseEvent => ({ t: "intent.status", id, status: state, seq: 0, ts });
const broken = (ts: number, id: string): PremiseEvent => ({ t: "premise.broken", id, symbol: "src/a.ts#f", byIntent: "i00000009", commit: "c1", reason: "r", seq: 0, ts });
const metrics = (ts: number): PremiseEvent => ({
	t: "metrics",
	metrics: { agentsActive: 0, intentsLanded: 0, brokenBuildsOnTrunk: 0, behaviouralRegressionsOnTrunk: 0, humanMerges: 0, premisesBroken: 0, rederives: { started: 0, succeeded: 0, failed: 0 }, forksCreated: 0, pushes: 0 },
	seq: 0,
	ts,
});
const numbered = (events: PremiseEvent[]): PremiseEvent[] => events.map((event, index) => ({ ...event, seq: index + 1 }));

describe("formatCut and parseCut", () => {
	it("says how long was cut, in minutes and seconds", () => {
		expect(formatCut(130_000)).toBe("⏩ 2m 10s compressed");
		expect(formatCut(120_000)).toBe("⏩ 2m compressed");
		expect(formatCut(9000)).toBe("⏩ 9s compressed");
		expect(formatCut(0)).toBe("⏩ 0s compressed");
	});

	it("reads back exactly what it wrote", () => {
		for (const ms of [1000, 9000, 59_000, 60_000, 61_000, 130_000, 3_600_000]) {
			expect(parseCut(formatCut(ms))).toBe(ms);
		}
	});

	it("does not read a label it did not write", () => {
		expect(parseCut("hi")).toBeNull();
		expect(parseCut("⏩ compressed")).toBeNull();
		expect(parseCut("⏩ 3 min compressed")).toBeNull();
	});
});

describe("compressRun", () => {
	const run = numbered([status(1000), status(2000), status(132_500), status(133_000), status(137_000), status(142_200)]);

	it("cuts a long silence to about a second and marks it with what was cut", () => {
		const { events, cuts, cutMs } = compressRun(run);
		// 2000 -> 132500 is 130.5 s of nothing: 129 whole seconds go, 1.5 s stay.
		// 137000 -> 142200 is 5.2 s: 4 s go, 1.2 s stay. The 4 s gap before it is not over the limit.
		expect(cuts).toBe(2);
		expect(cutMs).toBe(133_000);
		expect(events.map((event) => (event.t === "demo.marker" ? event.label : event.ts))).toEqual([1000, 2000, "⏩ 2m 9s compressed", 3500, 4000, 8000, "⏩ 4s compressed", 9200]);
	});

	it("renumbers so seq still counts up by one", () => {
		expect(compressRun(run).events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("puts the marker at the start of the pause that is left, so the player shows it while nothing moves", () => {
		const { events } = compressRun(run);
		expect(replayDelays(events, 1)).toEqual([0, 1000, 0, 1500, 500, 4000, 0, 1200]);
	});

	it("changes nothing the second time", () => {
		const once = compressRun(run).events;
		const twice = compressRun(once);
		expect(twice.cuts).toBe(0);
		expect(twice.events).toEqual(once);
	});

	it("leaves a run with no long silence alone, and copes with an empty one", () => {
		const busy = numbered([status(0), status(3000), status(7000)]);
		expect(compressRun(busy)).toEqual({ events: busy, cuts: 0, cutMs: 0 });
		expect(compressRun([])).toEqual({ events: [], cuts: 0, cutMs: 0 });
	});

	it("does not change the events it was given", () => {
		const copy = structuredClone(run);
		compressRun(run);
		expect(run).toEqual(copy);
	});
});

describe("realTimes", () => {
	it("puts the cut time back", () => {
		const run = numbered([status(1000), status(2000), status(132_500), status(133_000)]);
		const { events } = compressRun(run);
		const real = realTimes(events);
		// The marker itself sits at the start of the stretch it stands for, plus that stretch.
		expect(real).toEqual([0, 1000, 130_000, 131_500, 132_000]);
		expect(realTimes(run)).toEqual([0, 1000, 131_500, 132_000]);
	});
});

describe("nextStop", () => {
	const run = numbered([
		status(0), // 1
		status(1000), // 2
		broken(2000, "i00000002"), // 3
		status(2010, "i00000002", "stale"), // 4
		broken(2100, "i00000003"), // 5
		status(2110, "i00000003", "stale"), // 6
		status(5000), // 7
		{ t: "rederive.race", id: "i00000002", rebase: "pending", rederive: "pending", seq: 0, ts: 6000 }, // 8: no winner yet
		{ t: "rederive.race", id: "i00000002", rebase: "fail", rederive: "pass", winner: "rederive", seq: 0, ts: 9000 }, // 9
		{ t: "demo.marker", label: "⏩ 30s compressed", seq: 0, ts: 9500 }, // 10
		metrics(10_000), // 11: not the last
		{ t: "human.needed", id: "i00000004", kind: "stalemate", message: "m", options: ["Wait", "Split", "Depend"], seq: 0, ts: 11_000 }, // 12
		status(12_000), // 13
		metrics(13_000), // 14: the final numbers
	]);

	it("stops just past a premise break, taking in every break of the same landing and what each caused", () => {
		expect(nextStop(run, 0)).toBe(6);
		expect(nextStop(run, 2)).toBe(6);
	});

	it("stops at a race only once it has a winner", () => {
		expect(nextStop(run, 6)).toBe(9);
	});

	it("stops at markers, at a call for a person, and at the final numbers", () => {
		expect(nextStop(run, 9)).toBe(10);
		expect(nextStop(run, 10)).toBe(12);
		expect(nextStop(run, 12)).toBe(14);
	});

	it("goes to the end when nothing is left to stop at", () => {
		expect(nextStop(run, 14)).toBe(14);
		expect(nextStop(numbered([status(0), status(1)]), 0)).toBe(2);
		expect(nextStop([], 0)).toBe(0);
	});

	it("does not stop for the scripted workload", () => {
		const crowd = numbered([
			{ t: "intent.created", intent: { id: "i0000000w", kind: "workload", taskId: "workload", goal: "g", status: "working", claims: [], premises: [], why: [], baseCommit: "c0", headCommit: null, rederiveAttempts: 0 }, seq: 0, ts: 0 },
			broken(1000, "i0000000w"),
			{ t: "rederive.race", id: "i0000000w", rebase: "pass", rederive: "pending", winner: "rebase", seq: 0, ts: 2000 },
			broken(8000, "i00000002"),
			status(20_000),
		]);
		expect(nextStop(crowd, 0)).toBe(4);
	});

	it("only the last metrics event is a moment", () => {
		expect(momentKind(metrics(0), false)).toBeNull();
		expect(momentKind(metrics(0), true)).toBe("end");
	});
});
