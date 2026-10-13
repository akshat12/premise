import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../shared/runs";
import { isClean, runRows, runsHeadline, took, when } from "./runs";

const NOW = 1_800_000_000_000;
const run = (over: Partial<RunSummary> = {}): RunSummary => ({
	id: 3,
	origin: "visitor",
	startedAt: NOW - 10 * 60_000,
	endedAt: NOW - 10 * 60_000 + 192_000,
	complete: true,
	agents: { total: 12, landed: 12 },
	workload: { total: 30, landed: 26 },
	premisesBroken: 5,
	rederives: { started: 5, succeeded: 5, failed: 0 },
	problems: 0,
	people: 0,
	scripted: true,
	...over,
});

describe("took", () => {
	it("is minutes and seconds", () => {
		expect(took(192_000)).toBe("3:12");
		expect(took(9_400)).toBe("0:09");
		expect(took(0)).toBe("0:00");
		expect(took(-50)).toBe("0:00");
	});
});

describe("when", () => {
	it("says how long ago in plain words", () => {
		expect(when(NOW - 20_000, NOW)).toBe("just now");
		expect(when(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
		expect(when(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
		expect(when(NOW - 5 * 60 * 60_000, NOW)).toBe("5 hours ago");
		expect(when(NOW - 30 * 60 * 60_000, NOW)).toBe("yesterday");
		expect(when(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3 days ago");
		// A clock a little behind the Worker's must not say "in the future".
		expect(when(NOW + 4000, NOW)).toBe("just now");
	});
});

describe("runRows", () => {
	it("puts the run on the board first, then the earlier ones as given", () => {
		const rows = runRows({ current: run({ id: 0, startedAt: NOW - 30_000, endedAt: NOW - 1000, complete: false, agents: { total: 12, landed: 3 } }), past: [run({ id: 8 }), run({ id: 7, origin: "owner" })] }, NOW);
		expect(rows.map((row) => row.key)).toEqual(["current", "8", "7"]);
		expect(rows[0]).toMatchObject({ current: true, note: "running now", agents: "3 of 12", when: "just now", clean: false });
		expect(rows[1]).toMatchObject({ current: false, note: null, by: "a visitor", took: "3:12", agents: "12 of 12", workload: "26 of 30", rederived: "5 of 5", premisesBroken: 5, problems: 0, clean: true });
		expect(rows[2]?.by).toBe("the owner");
	});

	it("says so when a run is on the board and over, and when one was cleared half way", () => {
		expect(runRows({ current: run({ id: 0 }), past: [] }, NOW)[0]?.note).toBe("on the board now");
		expect(runRows({ current: null, past: [run({ complete: false })] }, NOW)[0]).toMatchObject({ note: "cleared before it finished", clean: false });
	});

	it("says none where there was none of something", () => {
		expect(runRows({ current: null, past: [run({ workload: { total: 0, landed: 0 }, rederives: { started: 0, succeeded: 0, failed: 0 } })] }, NOW)[0]).toMatchObject({ workload: "none", rederived: "none" });
	});
});

describe("isClean", () => {
	it("needs a finished run, every agent landed, and nothing broken on trunk", () => {
		expect(isClean(run())).toBe(true);
		expect(isClean(run({ problems: 1 }))).toBe(false);
		expect(isClean(run({ agents: { total: 12, landed: 11 } }))).toBe(false);
		expect(isClean(run({ complete: false }))).toBe(false);
		// Workload Intents that gave up waiting do not make a run unclean: that is the ledger working.
		expect(isClean(run({ workload: { total: 30, landed: 20 } }))).toBe(true);
	});
});

describe("runsHeadline", () => {
	it("says there are none, or that one is going", () => {
		expect(runsHeadline({ current: null, past: [] })).toBe("No live runs yet.");
		expect(runsHeadline({ current: run({ id: 0, complete: false }), past: [] })).toBe("A run is on the board now.");
	});

	it("counts what happened, whichever way it went", () => {
		expect(runsHeadline({ current: run({ id: 0 }), past: [] })).toBe("The last live run landed every agent, with nothing broken on trunk.");
		expect(runsHeadline({ current: null, past: [run({ problems: 1 })] })).toBe("The last live run did not land every agent cleanly.");
		expect(runsHeadline({ current: run({ id: 0 }), past: [run(), run()] })).toBe("The last 3 live runs each landed every agent, with nothing broken on trunk.");
		expect(runsHeadline({ current: null, past: [run(), run({ problems: 1 }), run()] })).toBe("2 of the last 3 live runs landed every agent with nothing broken on trunk.");
	});

	it("leaves out a run that is still going, and one that was cleared half way", () => {
		expect(runsHeadline({ current: run({ id: 0, complete: false }), past: [run(), run({ complete: false })] })).toBe("The last live run landed every agent, with nothing broken on trunk.");
	});
});
