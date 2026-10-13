import { describe, expect, it } from "vitest";
import { emptyCounters } from "../metrics";
import type { PremiseEventBody } from "../../shared/events";
import { landingOf, type RunFacts, summariseRun } from "./runs";

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

describe("landingOf", () => {
	const created = (id: string, baseCommit: string) => ({ t: "intent.created", intent: { id, baseCommit } }) as unknown as PremiseEventBody;
	const gated = (intentId: string, landedCommit: string | null) => ({ t: "gate.result", report: { intentId, landedCommit, ok: landedCommit !== null } }) as unknown as PremiseEventBody;
	const advanced = (commit: string, byIntent: string | null): PremiseEventBody => ({ t: "trunk.advanced", commit, byIntent, changedSymbols: [] });
	// Three agents land one after another; the third is turned back once first.
	const run = [created("a1", "c0"), created("a2", "c0"), created("a3", "c0"), gated("a1", "c1"), advanced("c1", "a1"), gated("a3", null), gated("a2", "c2"), advanced("c2", "a2"), gated("a3", "c3"), advanced("c3", "a3")];

	it("finds the commit that landed an Intent and the commit trunk was at before", () => {
		expect(landingOf(run, "a1")).toEqual({ commit: "c1", parent: "c0", together: 1 });
		expect(landingOf(run, "a2")).toEqual({ commit: "c2", parent: "c1", together: 1 });
		// A gate result that did not land is not a landing; the one that did is.
		expect(landingOf(run, "a3")).toEqual({ commit: "c3", parent: "c2", together: 1 });
	});

	it("has nothing for an Intent that did not land, or is not in the run", () => {
		expect(landingOf([...run, created("a4", "c1"), gated("a4", null)], "a4")).toBeNull();
		expect(landingOf(run, "nobody")).toBeNull();
		expect(landingOf([], "a1")).toBeNull();
	});

	it("finds every member of a commit that landed several workload Intents, and says how many it carried", () => {
		// The announcement names one of them; the gate's results name them all.
		const batch = [...run, created("w1", "c3"), created("w2", "c3"), created("w3", "c3"), gated("w1", "c4"), gated("w2", "c4"), gated("w3", "c4"), advanced("c4", "w1")];
		for (const id of ["w1", "w2", "w3"]) {
			expect(landingOf(batch, id), id).toEqual({ commit: "c4", parent: "c3", together: 3 });
		}
	});

	it("says an Intent whose work was already on trunk landed without a commit of its own", () => {
		// The gate reports the commit trunk was already at, and trunk is not announced to have moved.
		expect(landingOf([...run, created("w1", "c3"), gated("w1", "c3")], "w1")).toEqual({ commit: "c3", parent: "c3", together: 1 });
	});

	it("counts trunk moving by something that was not an Intent", () => {
		const pushed = [created("a1", "c0"), advanced("cx", null), gated("a1", "c1"), advanced("c1", "a1")];
		expect(landingOf(pushed, "a1")).toEqual({ commit: "c1", parent: "cx", together: 1 });
	});

	it("does not guess when the log never says where trunk was", () => {
		expect(landingOf([gated("a1", "c1"), advanced("c1", "a1")], "a1")).toBeNull();
	});
});

describe("the trunk a run was on", () => {
	it("is named in the run's line when it is known", () => {
		expect(summariseRun(facts({ trunk: "trunk-abc" }))).toMatchObject({ trunk: "trunk-abc" });
		expect(summariseRun(facts({ trunk: null }))).not.toHaveProperty("trunk");
		expect(summariseRun(facts())).not.toHaveProperty("trunk");
	});
});
