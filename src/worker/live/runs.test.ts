import { describe, expect, it } from "vitest";
import { emptyCounters } from "../metrics";
import { type RunFacts, summariseRun } from "./runs";

const T0 = 1_800_000_000_000;
const row = (kind: "agent" | "workload", status: string) => ({ kind, status }) as RunFacts["registry"][number];
const facts = (over: Partial<RunFacts> = {}): RunFacts => ({
	id: 7,
	origin: "visitor",
	registry: [...Array.from({ length: 12 }, () => row("agent", "landed")), ...Array.from({ length: 26 }, () => row("workload", "landed")), ...Array.from({ length: 4 }, () => row("workload", "failed"))],
	counters: { ...emptyCounters(), premisesBroken: 5, rederives: { started: 5, succeeded: 5, failed: 0 }, forksCreated: 45, pushes: 50 },
	firstTs: T0,
	lastTs: T0 + 192_000,
	scripted: true,
	...over,
});

describe("summariseRun", () => {
	it("says how a finished run went, in one line", () => {
		expect(summariseRun(facts())).toEqual({
			id: 7,
			origin: "visitor",
			startedAt: T0,
			endedAt: T0 + 192_000,
			complete: true,
			agents: { total: 12, landed: 12 },
			workload: { total: 30, landed: 26 },
			premisesBroken: 5,
			rederives: { started: 5, succeeded: 5, failed: 0 },
			problems: 0,
			people: 0,
			scripted: true,
		});
	});

	it("counts a regression and a broken build as problems, and says when a person stepped in", () => {
		const counters = { ...emptyCounters(), behaviouralRegressionsOnTrunk: 1, brokenBuildsOnTrunk: 2, humanMerges: 1 };
		expect(summariseRun(facts({ counters }))).toMatchObject({ problems: 3, people: 1 });
	});

	it("is not complete while any Intent is still moving", () => {
		for (const status of ["planning", "working", "queued", "gating", "stale", "rederiving", "waiting"]) {
			expect(summariseRun(facts({ registry: [row("agent", "landed"), row("agent", status)] })), status).toMatchObject({ complete: false, agents: { total: 2, landed: 1 } });
		}
		// Waiting for a person is at rest: nothing more will happen by itself.
		expect(summariseRun(facts({ registry: [row("agent", "landed"), row("agent", "escalated")] }))).toMatchObject({ complete: true });
	});

	it("has no line for a board with no agents on it", () => {
		expect(summariseRun(facts({ registry: [] }))).toBeNull();
		expect(summariseRun(facts({ registry: [row("workload", "landed")] }))).toBeNull();
	});

	it("never ends before it starts", () => {
		expect(summariseRun(facts({ lastTs: T0 - 5 }))).toMatchObject({ startedAt: T0, endedAt: T0 });
	});

	it("copies the re-derive counts, so the record does not change with the counters", () => {
		const input = facts();
		const summary = summariseRun(input);
		input.counters.rederives.started = 99;
		expect(summary?.rederives.started).toBe(5);
	});
});
