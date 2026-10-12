import { describe, expect, it } from "vitest";
import { emptyCounters } from "../metrics";
import { hiddenTestFile, hiddenTests, newlyRed, probeFile, redTests, testKey } from "./regress";
import { buildReport, type ModeResult, renderMarkdown, shareCount, spread, sumOfNumbers, type Trial } from "./report";

const result = (mode: ModeResult["mode"], fields: Partial<ModeResult> = {}): ModeResult => ({
	...emptyCounters(),
	agentsActive: 0,
	intentsLanded: 40,
	mode,
	n: 30,
	seed: 7,
	trunk: `trunk-${mode}`,
	wallTimeMs: 60_000,
	landingsPerMinute: 40,
	tasksLanded: 12,
	tasksDispatched: 12,
	ends: { landed: 40, failed: 0, escalated: 0, other: 0 },
	races: { started: 0, rebaseWon: 0, rederiveWon: 0, failed: 0 },
	agentRaces: { started: 0, rebaseWon: 0, rederiveWon: 0, failed: 0 },
	falsePositiveRate: 0,
	rejected: { textConflicts: 0, typecheck: 0, checks: 0 },
	claimsLost: 0,
	redReferenceTests: [],
	finalTypecheckOk: true,
	...fields,
});

const trial = (seed: number, baseline: Partial<ModeResult> = {}, queue: Partial<ModeResult> = {}, premise: Partial<ModeResult> = {}): Trial => ({
	seed,
	baseline: result("baseline", { seed, ...baseline }),
	queue: result("queue", { seed, ...queue }),
	premise: result("premise", { seed, ...premise }),
});

describe("buildReport", () => {
	it("writes the headline from the numbers, with the grammar to match", () => {
		const report = buildReport([trial(7, { behaviouralRegressionsOnTrunk: 3 }, { behaviouralRegressionsOnTrunk: 1, tasksLanded: 10 }, {})]);
		expect(report.headline).toBe(
			"A queue that only typechecks shipped 3 behavioural regressions and sent 0 of 12 tasks back to a person; a queue that also runs the tests shipped 1 behavioural regression and sent 2 of 12 tasks back to a person; Premise shipped 0 behavioural regressions and sent 0 of 12 tasks back to a person.",
		);
		// Different numbers, different sentence: nothing about the outcome is assumed.
		const flipped = buildReport([trial(7, {}, {}, { behaviouralRegressionsOnTrunk: 2, tasksLanded: 7 })]);
		expect(flipped.headline).toContain("Premise shipped 2 behavioural regressions and sent 5 of 12 tasks back to a person.");
		expect(flipped.headline).toContain("A queue that only typechecks shipped 0 behavioural regressions");
	});

	it("has a row for every metric the comparison is about, with all three rules' values", () => {
		const baseline = { behaviouralRegressionsOnTrunk: 3, humanMerges: 4, rejected: { textConflicts: 4, typecheck: 1, checks: 0 }, redReferenceTests: ["premise/hidden-tests/t02-audit-expired.test.ts#x"], forksCreated: 42, wallTimeMs: 61_500, landingsPerMinute: 39.02, ends: { landed: 37, failed: 5, escalated: 0, other: 0 }, intentsLanded: 37 };
		const queue = { behaviouralRegressionsOnTrunk: 1, humanMerges: 4, tasksLanded: 10, rejected: { textConflicts: 4, typecheck: 1, checks: 2 }, ends: { landed: 35, failed: 7, escalated: 0, other: 0 }, intentsLanded: 35 };
		const premise = { claimsLost: 5, premisesBroken: 9, races: { started: 9, rebaseWon: 6, rederiveWon: 3, failed: 0 }, agentRaces: { started: 3, rebaseWon: 0, rederiveWon: 3, failed: 0 }, falsePositiveRate: 6 / 9, forksCreated: 45, rejected: { textConflicts: 0, typecheck: 0, checks: 3 }, ends: { landed: 37, failed: 5, escalated: 0, other: 0 }, intentsLanded: 37 };
		const rows = Object.fromEntries(buildReport([trial(7, baseline, queue, premise)]).table.map((row) => [row.metric, [row.baseline, row.queue, row.premise]]));
		expect(rows).toMatchObject({
			"Behavioural regressions that reached trunk": ["3", "1", "0"],
			"Demo tasks sent back to a person": ["0 of 12", "2 of 12", "0 of 12"],
			"Stopped Intents redone and landed with nobody involved": ["0", "0", "3"],
			"Broken builds on trunk": ["0", "0", "0"],
			"Scripted workload Intents that did not land": ["5", "5", "5"],
			"Human merges": ["4", "4", "0"],
			"Intents landed": ["37 of 42", "35 of 42", "37 of 42"],
			"Premises broken": ["0", "0", "9"],
			"Stopped Intents a plain rebase settled": ["0", "0", "6"],
			"False positives: agents": ["n/a", "n/a", "0% (0 of 3)"],
			"False positives: scripted workload": ["n/a", "n/a", "100% (6 of 6)"],
			"Turned away at the gate": ["4 text, 1 type, 0 checks", "4 text, 1 type, 2 checks", "0 text, 0 type, 3 checks"],
			"Gave up waiting for a claim": ["0", "0", "5"],
			"Landings per minute": ["39.0", "40.0", "40.0"],
			"Wall time": ["61.5 s", "60.0 s", "60.0 s"],
			"Reference checks and probes failing at the end": ["1", "0", "0"],
			"Forks created": ["42", "0", "45"],
		});
	});

	it("gives the lowest and highest value where seeds disagree, and one value where they agree", () => {
		expect(spread(["3", "3", "3"])).toBe("3");
		expect(spread(["11", "9", "14"])).toBe("9 to 14");
		// A cell that holds several counts is ordered by their total, not by the zero it starts with.
		expect(spread(["0 text, 0 type, 0 checks", "0 text, 0 type, 3 checks", "0 text, 0 type, 2 checks"], sumOfNumbers)).toBe("0 text, 0 type, 0 checks to 0 text, 0 type, 3 checks");
		expect(sumOfNumbers("2 text, 1 type, 4 checks")).toBe(7);
		// Shares that are all 100% are ordered by how many they count, not left in the order the runs were made.
		expect(spread(["100% (14 of 14)", "100% (25 of 25)", "100% (19 of 19)"], shareCount)).toBe("100% (14 of 14) to 100% (25 of 25)");
		expect(spread(["0% (0 of 3)", "25% (1 of 4)"], shareCount)).toBe("0% (0 of 3) to 25% (1 of 4)");
		const trials = [trial(7, { behaviouralRegressionsOnTrunk: 3, humanMerges: 11 }), trial(11, { behaviouralRegressionsOnTrunk: 3, humanMerges: 9 }), trial(23, { behaviouralRegressionsOnTrunk: 3, humanMerges: 14 })];
		const rows = Object.fromEntries(buildReport(trials).table.map((row) => [row.metric, row.baseline]));
		expect(rows["Behavioural regressions that reached trunk"]).toBe("3");
		expect(rows["Human merges"]).toBe("9 to 14");
	});

	it("renders a Markdown document that says how the rules differ, what the scenario builds in, and what is red", () => {
		const red = "premise/probes/t11-expired-rate-limit.test.ts#a client replaying an expired session is turned away on the fourth request";
		const text = renderMarkdown([trial(7, {}, { behaviouralRegressionsOnTrunk: 1, redReferenceTests: [red] })], { date: "2026-10-11", source: "https://example.test" });
		expect(text).toContain("a queue that also runs the tests shipped 1 behavioural regression and sent 0 of 12 tasks back to a person");
		expect(text).toContain("Run on 2026-10-11 against https://example.test.");
		expect(text).toContain("the same scripted workload (30 Intents)");
		expect(text).toContain("for seed 7.");
		expect(text).toContain("| | Typecheck only | Queue with tests | Premise |");
		expect(text).toContain("| Behavioural regressions that reached trunk | 0 | 1 | 0 |");
		expect(text).toContain("## What is built into the scenario");
		expect(text).toContain("The rebase, the typecheck and the test runner are the same code in all three.");
		expect(text).toContain("## Failing on trunk at the end: A queue that also runs the tests, seed 7");
		expect(text).toContain(`- \`${red}\``);
		expect(text).not.toContain("at the end: Premise");
		// The product's own words only.
		expect(text).not.toMatch(/merge queue|pull request|\bPR\b|\bbranch\b/i);
	});
});

describe("counting regressions", () => {
	const tasks = [
		{ id: "t01", acceptance: [{ id: "a", description: "", testFile: "tests/one.test.ts", testName: "one works" }] },
		{ id: "t02", acceptance: [{ id: "b", description: "", testFile: "tests/two.test.ts", testName: "two works" }, { id: "c", description: "", testFile: "tests/two.test.ts", testName: "two still works" }] },
	];
	const files = { [hiddenTestFile("t01")]: "x", [hiddenTestFile("t02")]: "y" };

	it("runs the reference tests of the tasks that have landed, from the hidden files, not the agents' own copies", () => {
		expect(hiddenTests(tasks, ["t02"], files)).toEqual([
			{ file: "premise/hidden-tests/t02.test.ts", name: "two works" },
			{ file: "premise/hidden-tests/t02.test.ts", name: "two still works" },
		]);
		expect(hiddenTests(tasks, [], files)).toEqual([]);
		expect(hiddenTests(tasks, ["t01", "t02"], { [hiddenTestFile("t01")]: "x" })).toEqual([{ file: "premise/hidden-tests/t01.test.ts", name: "one works" }]);
	});

	it("adds a landed task's end-to-end probe, every test in it, when trunk has one", () => {
		const withProbe = { ...files, [probeFile("t02")]: 'export const tests = { "the real path works": () => {}, "and keeps working": () => {} };' };
		expect(hiddenTests(tasks, ["t02"], withProbe).slice(2)).toEqual([
			{ file: "premise/probes/t02.test.ts", name: "the real path works" },
			{ file: "premise/probes/t02.test.ts", name: "and keeps working" },
		]);
		expect(hiddenTests(tasks, ["t01"], withProbe)).toEqual([{ file: "premise/hidden-tests/t01.test.ts", name: "one works" }]);
	});

	it("a test is red if it failed, and every test is red if nothing loaded", () => {
		const asked = hiddenTests(tasks, ["t01", "t02"], files);
		const run = { tests: asked.map((test, index) => ({ ...test, ok: index !== 1, ms: 1 })) };
		expect(redTests(asked, run)).toEqual([testKey("premise/hidden-tests/t02.test.ts", "two works")]);
		expect(redTests(asked, { tests: [], loadError: "syntax error" })).toHaveLength(3);
	});

	it("counts a test once when it goes red, not again while it stays red", () => {
		expect(newlyRed([], ["a", "b"])).toEqual(["a", "b"]);
		expect(newlyRed(["a"], ["a", "b"])).toEqual(["b"]);
		expect(newlyRed(["a", "b"], ["a"])).toEqual([]);
	});
});
