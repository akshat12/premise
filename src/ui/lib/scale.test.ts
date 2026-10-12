import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { compressRun } from "./demo";
import { artifactsOperations, bucketCounts, operationsCost, scaleStats } from "./scale";

const status = (ts: number, state: "working" | "landed" = "working", id = "i00000001"): PremiseEvent => ({ t: "intent.status", id, status: state, seq: 0, ts });
const decision = (ts: number, kind: "granted" | "wait"): PremiseEvent => ({
	t: "claim.decision",
	id: "i00000001",
	decision: kind === "granted" ? { kind } : { kind, on: "i00000002", symbols: ["src/a.ts#f"] },
	symbols: ["src/a.ts#f"],
	seq: 0,
	ts,
});
const numbered = (events: PremiseEvent[]): PremiseEvent[] => events.map((event, index) => ({ ...event, seq: index + 1 }));

describe("bucketCounts", () => {
	it("counts landings in each 10 s of the span", () => {
		expect(bucketCounts([0, 500, 9999, 10_000, 25_000], 30_000)).toEqual([3, 1, 1]);
	});

	it("covers the whole span even where nothing landed", () => {
		expect(bucketCounts([1000], 45_000)).toEqual([1, 0, 0, 0, 0]);
		expect(bucketCounts([], 0)).toEqual([0]);
	});
});

describe("scaleStats", () => {
	const run = numbered([status(0), decision(100, "granted"), decision(200, "wait"), status(15_000, "landed"), status(30_000, "landed", "i00000002"), status(40_000)]);

	it("counts landings a minute up to the last landing, and claims that were not granted at once", () => {
		const stats = scaleStats(run);
		expect(stats.landingTimes).toEqual([15_000, 30_000]);
		expect(stats.landingsPerMinute).toBe(4);
		expect(stats.contention).toBe(1);
		expect(stats.contended).toBe(1);
		expect(stats.elapsedMs).toBe(40_000);
		expect(stats.buckets).toEqual([0, 1, 0, 1]);
	});

	it("is not fooled by a compressed recording: rates use the time that really passed", () => {
		const slow = numbered([status(0), status(60_000, "landed"), status(120_000, "landed", "i00000002")]);
		const compressed = compressRun(slow).events;
		expect(compressed.at(-1)?.ts).toBeLessThan(5000);
		const stats = scaleStats(compressed);
		expect(stats.landingTimes).toEqual([60_000, 120_000]);
		expect(stats.landingsPerMinute).toBe(1);
	});

	it("is all zeros for an empty log", () => {
		expect(scaleStats([])).toEqual({ landingTimes: [], buckets: [0], landingsPerMinute: 0, contention: 0, contended: 0, elapsedMs: 0 });
	});
});

describe("Artifacts operations", () => {
	it("is a fork each, and a clone and a push for each commit", () => {
		expect(artifactsOperations({ forksCreated: 115, pushes: 122 })).toBe(359);
	});

	it("costs $0.15 per thousand", () => {
		expect(operationsCost(1000)).toBeCloseTo(0.15);
		expect(operationsCost(359)).toBeCloseTo(0.05385);
	});
});
