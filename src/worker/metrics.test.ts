import { describe, expect, it } from "vitest";
import type { PremiseEventBody } from "../shared/events";
import { computeMetrics, countEvent, emptyCounters } from "./metrics";

const count = (events: PremiseEventBody[]) => events.reduce(countEvent, emptyCounters());
const SHA = "a".repeat(40);

describe("countEvent", () => {
	it("counts forks and pushes from artifacts events, and nothing else from them", () => {
		const counters = count([{ t: "artifacts", type: "forked", repo: "i1" }, { t: "artifacts", type: "forked", repo: "i2" }, { t: "artifacts", type: "pushed", repo: "i1" }, { t: "artifacts", type: "repo.created", repo: "x" }]);
		expect(counters).toMatchObject({ forksCreated: 2, pushes: 1 });
	});

	it("counts broken premises", () => {
		expect(count([{ t: "premise.broken", id: "i1", symbol: "src/a.ts#b", byIntent: "i2", commit: SHA, reason: "r" }]).premisesBroken).toBe(1);
	});

	it("counts a re-derive as started, then as succeeded or failed", () => {
		const start: PremiseEventBody = { t: "rederive.race", id: "i1", rebase: "pending", rederive: "pending" };
		const partial: PremiseEventBody = { t: "rederive.race", id: "i1", rebase: "fail", rederive: "pending" };
		expect(count([start, partial, { t: "rederive.race", id: "i1", rebase: "fail", rederive: "pass", winner: "rederive" }]).rederives).toEqual({ started: 1, succeeded: 1, failed: 0 });
		expect(count([start, { t: "rederive.race", id: "i1", rebase: "fail", rederive: "fail" }]).rederives).toEqual({ started: 1, succeeded: 0, failed: 1 });
		expect(count([start, { t: "rederive.race", id: "i1", rebase: "pass", rederive: "pending", winner: "rebase" }]).rederives.succeeded).toBe(1);
	});

	it("counts each time a person is needed", () => {
		// A fallback cannot move without a person, so it counts when it is raised.
		expect(count([{ t: "human.needed", id: "i1", kind: "fallback", message: "m", options: ["Retry", "Abandon"] }]).humanMerges).toBe(1);
		// A stalemate card counts only if a person answers it; otherwise the Intent went on by itself.
		expect(count([{ t: "human.needed", id: "i1", kind: "stalemate", message: "m", options: ["Wait"] }]).humanMerges).toBe(0);
		expect(count([{ t: "human.needed", id: "i1", kind: "stalemate", message: "m", options: ["Wait"] }, { t: "human.resolved", id: "i1", choice: "Split" }]).humanMerges).toBe(1);
		// Answering a fallback does not count it a second time.
		expect(count([{ t: "human.needed", id: "i1", kind: "fallback", message: "m", options: ["Retry", "Abandon"] }, { t: "human.resolved", id: "i1", choice: "Retry" }]).humanMerges).toBe(1);
	});

	it("returns the same object for events that change nothing", () => {
		const counters = emptyCounters();
		expect(countEvent(counters, { t: "intent.status", id: "i1", status: "working" })).toBe(counters);
		expect(countEvent(counters, { t: "demo.marker", label: "x" })).toBe(counters);
	});
});

describe("computeMetrics", () => {
	it("takes active and landed counts from the registry", () => {
		const metrics = computeMetrics({ ...emptyCounters(), pushes: 3 }, [
			{ kind: "agent", status: "working" },
			{ kind: "agent", status: "stale" },
			{ kind: "workload", status: "queued" },
			{ kind: "agent", status: "landed" },
			{ kind: "agent", status: "landed" },
			{ kind: "agent", status: "failed" },
		]);
		expect(metrics).toMatchObject({ agentsActive: 3, intentsLanded: 2, pushes: 3, brokenBuildsOnTrunk: 0 });
	});

	it("is all zeroes to start with", () => {
		expect(computeMetrics(emptyCounters(), [])).toEqual({ agentsActive: 0, intentsLanded: 0, brokenBuildsOnTrunk: 0, behaviouralRegressionsOnTrunk: 0, humanMerges: 0, premisesBroken: 0, rederives: { started: 0, succeeded: 0, failed: 0 }, forksCreated: 0, pushes: 0 });
	});
});
