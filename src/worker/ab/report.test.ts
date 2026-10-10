import { describe, expect, it } from "vitest";
import { emptyCounters } from "../metrics";
import { hiddenTestFile, hiddenTests, newlyRed, redTests, testKey } from "./regress";
import { buildReport, type ModeResult, renderMarkdown } from "./report";

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
	ends: { landed: 40, failed: 2, escalated: 0, other: 0 },
	races: { started: 0, rebaseWon: 0, rederiveWon: 0, failed: 0 },
	falsePositiveRate: 0,
	rejected: { textConflicts: 0, typecheck: 0, checks: 0 },
	claimsLost: 0,
	redReferenceTests: [],
	finalTypecheckOk: true,
	...fields,
});

describe("buildReport", () => {
	it("writes the headline from the numbers, with the grammar to match", () => {
		const report = buildReport(result("baseline", { behaviouralRegressionsOnTrunk: 3, humanMerges: 7 }), result("premise", { behaviouralRegressionsOnTrunk: 0, humanMerges: 1 }));
		expect(report.headline).toBe("Baseline shipped 3 behavioural regressions and needed 7 human merges; Premise shipped 0 behavioural regressions and needed 1 human merge.");
		// Different numbers, different sentence: nothing about the outcome is assumed.
		const flipped = buildReport(result("baseline", { behaviouralRegressionsOnTrunk: 1, humanMerges: 0 }), result("premise", { behaviouralRegressionsOnTrunk: 2, humanMerges: 5 }));
		expect(flipped.headline).toBe("Baseline shipped 1 behavioural regression and needed 0 human merges; Premise shipped 2 behavioural regressions and needed 5 human merges.");
	});

	it("has a row for every metric the comparison is about, with both modes' values", () => {
		const baseline = result("baseline", { behaviouralRegressionsOnTrunk: 3, humanMerges: 4, rejected: { textConflicts: 4, typecheck: 1, checks: 0 }, redReferenceTests: ["premise/hidden-tests/t02-audit-expired.test.ts#x"], forksCreated: 42, wallTimeMs: 61_500, landingsPerMinute: 39.02 });
		const premise = result("premise", { claimsLost: 5, premisesBroken: 9, races: { started: 9, rebaseWon: 6, rederiveWon: 3, failed: 0 }, falsePositiveRate: 6 / 9, forksCreated: 45, rejected: { textConflicts: 0, typecheck: 0, checks: 3 } });
		const rows = Object.fromEntries(buildReport(baseline, premise).table.map((row) => [row.metric, [row.baseline, row.premise]]));
		expect(rows).toMatchObject({
			"Behavioural regressions that reached trunk": ["3", "0"],
			"Human merges": ["4", "0"],
			"Broken builds on trunk": ["0", "0"],
			"Demo tasks landed": ["12 of 12", "12 of 12"],
			"Intents landed": ["40 of 42", "40 of 42"],
			"Landings per minute": ["39.0", "40.0"],
			"Wall time": ["61.5 s", "60.0 s"],
			"Premises broken": ["0", "9"],
			"Stale Intents settled by re-derive": ["0", "3"],
			"Stale Intents a plain rebase settled": ["0", "6"],
			"False-positive rate": ["n/a", "67%"],
			"Turned away at the gate": ["4 text, 1 type, 0 checks", "0 text, 0 type, 3 checks"],
			"Gave up waiting for a claim": ["0", "5"],
			"Reference tests red at the end": ["1", "0"],
			"Forks created": ["42", "45"],
		});
	});

	it("renders a Markdown document that says how the two modes differ and lists what is red", () => {
		const baseline = result("baseline", { behaviouralRegressionsOnTrunk: 1, redReferenceTests: ["premise/hidden-tests/t02-audit-expired.test.ts#an expired session writes an audit entry and returns expired"] });
		const text = renderMarkdown(baseline, result("premise"), { date: "2026-10-09", source: "https://example.test" });
		expect(text).toContain("**Baseline shipped 1 behavioural regression and needed 0 human merges; Premise shipped 0 behavioural regressions and needed 0 human merges.**");
		expect(text).toContain("Run on 2026-10-09 against https://example.test.");
		expect(text).toContain("the same scripted workload (30 Intents, seed 7)");
		expect(text).toContain("| Behavioural regressions that reached trunk | 1 | 0 |");
		expect(text).toContain("The rebase function and the typecheck are the same code in both.");
		expect(text).toContain("## Reference tests red on trunk at the end (Baseline)");
		expect(text).not.toContain("at the end (Premise)");
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
