import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import live from "../../../demo/runs/live.json";
import main from "../../../demo/runs/main.json";
import recording from "../fixtures/run-2026-10-09.json";
import { captionAt, compressRun, formatCut, momentKind, nextStop, parseCut, realTimes } from "./demo";
import { readRecording } from "./recording";
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

	it("passes a marker, and stops at a call for a person and at the final numbers", () => {
		expect(nextStop(run, 9)).toBe(12);
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

describe("captionAt, on the Oct 9 run of twelve agents and a workload", () => {
	const run = recording as PremiseEvent[];
	const stops: number[] = [];
	for (let at = 0; at < run.length; ) {
		at = nextStop(run, at);
		stops.push(at);
	}

	it("says what the recording is and how to step through it, before anything has happened", () => {
		expect(captionAt(run, 0)).toBe('A recorded run on real Artifacts: 12 agents and 285 scripted workload Intents, each on its own fork. Press Next, or the → key, to step through it.');
		expect(captionAt(run, 200)).toBe(captionAt(run, 0));
	});

	it("explains each key moment in a sentence", () => {
		expect(captionAt(run, stops[0] ?? 0)).toBe("T05 TAX edited a symbol another Intent is changing, and is held. A person may choose Wait, Split or Depend; if nobody does, it is settled when the other Intent lands.");
		expect(captionAt(run, stops[1] ?? 0)).toBe("T01 NULL landed and changed verifySession. T02 AUDIT, T03 EXPIRED and T11 EXPIRED had recorded that they rely on it. All three are stopped until their work is redone. T04 SESSION read it too, but relies only on its type, which did not change.");
		expect(captionAt(run, stops[2] ?? 0)).toBe("T02 AUDIT: a plain rebase did not pass the gate. Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.");
		expect(captionAt(run, run.length)).toBe("The run is over: 264 Intents landed, 0 broken builds on trunk, nobody was needed.");
	});

	it("keeps saying the last moment until the next one", () => {
		expect(captionAt(run, (stops[1] ?? 0) + 40)).toBe(captionAt(run, stops[1] ?? 0));
	});
});

describe("the front-page demo recording: four agents, one break", () => {
	const run = readRecording(main).events;
	const stops: number[] = [];
	for (let at = 0; at < run.length; ) {
		at = nextStop(run, at);
		stops.push(at);
	}

	it("has four stops: the break, the two re-derives, and the end", () => {
		expect(stops).toHaveLength(4);
		expect(stops.at(-1)).toBe(run.length);
	});

	it("tells the whole story in five sentences", () => {
		expect(captionAt(run, 0)).toBe('A recorded run on real Artifacts: 4 agents, each on its own fork. Press Next, or the → key, to step through it.');
		expect(captionAt(run, stops[0] ?? 0)).toBe(
			"T01 NULL landed and changed verifySession. T02 AUDIT and T11 EXPIRED had recorded that they rely on it. Both are stopped until their work is redone. T04 SESSION read it too, but relies only on its type, which did not change.",
		);
		expect(captionAt(run, stops[1] ?? 0)).toBe("T02 AUDIT: a plain rebase did not pass the gate. Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.");
		expect(captionAt(run, stops[2] ?? 0)).toBe(
			"T11 EXPIRED: after a plain rebase every test passed, but its premise no longer held, so the gate turned it back. Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.",
		);
		expect(captionAt(run, run.length)).toBe("The run is over: 4 Intents landed, 0 broken builds on trunk, nobody was needed.");
	});

	it("carries what each of the four agents changed", () => {
		const recorded = readRecording(main);
		expect(Object.keys(recorded.diffs)).toHaveLength(4);
		expect(Object.values(recorded.diffs).every((diff) => diff.files.length > 0)).toBe(true);
	});
});

describe("the live-model demo recording", () => {
	const run = readRecording(live).events;

	it("opens with what is different about it, when told", () => {
		expect(captionAt(run, 0, "Four agents, a live model.")).toBe('Four agents, a live model. Press Next, or the → key, to step through it.');
	});

	it("says an Intent was stopped before it had pushed, where that is what happened, and that T11's tests all passed", () => {
		const captions: string[] = [];
		for (let at = 0; at < run.length; ) {
			at = nextStop(run, at);
			captions.push(captionAt(run, at));
		}
		expect(captions[0]).toBe("T01 NULL landed and changed verifySession. T02 AUDIT, T04 SESSION and T11 EXPIRED had recorded that they rely on it. All three are stopped until their work is redone.");
		expect(captions).toContain("T02 AUDIT: it was stopped before it had pushed anything, so there was nothing to rebase. Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.");
		expect(captions).toContain("T11 EXPIRED: after a plain rebase every test passed, but its premise no longer held, so the gate turned it back. Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.");
		expect(captions.at(-1)).toBe("The run is over: 4 Intents landed, 0 broken builds on trunk, nobody was needed.");
	});
});
