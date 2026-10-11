import { describe, expect, it } from "vitest";
import type { Assertion, Intent, Premise } from "../../shared/types";
import { describeStandingFailure, judgeStanding, MemoryStandingStore, planStanding, type Standing, standingAssertionId, standingOf, standingRequest, TAMPERED } from "./standing";

const assertion = (id: string, description = `premise ${id}`): Assertion => ({ id, description, code: "", imports: [] });
const check = (testFile: string, testName: string) => ({ id: testName, description: testName, testFile, testName });
const X: Standing = { intentId: "ilandedx1", tests: [{ file: "tests/x.test.ts", name: "x works" }, { file: "tests/x.test.ts", name: "x still works" }], assertions: [{ symbol: "src/s.ts#f", assertion: assertion("a1", "f throws") }] };
const Y: Standing = { intentId: "ilandedy1", tests: [{ file: "tests/y.test.ts", name: "y works" }], assertions: [] };
const trunk = { "tests/x.test.ts": "x tests", "tests/y.test.ts": "y tests", "src/s.ts": "code" };
const lander = { id: "ilander01", acceptance: [check("tests/l.test.ts", "l works")] };

describe("standingOf", () => {
	it("is the Intent's acceptance tests and the assertions that still hold", () => {
		const premises: Premise[] = [
			{ symbol: "src/s.ts#f", source: "asserted", surfaceHash: null, state: "holding", assertion: assertion("a1") },
			{ symbol: "src/s.ts#g", source: "asserted", surfaceHash: null, state: "broken", assertion: assertion("a2") },
			{ symbol: "src/s.ts#f", source: "observed", surfaceHash: "h", state: "holding" },
		];
		const intent = { id: "i1", acceptance: [check("tests/x.test.ts", "x works")], premises } as Pick<Intent, "id" | "acceptance" | "premises">;
		expect(standingOf(intent)).toEqual({ intentId: "i1", tests: [{ file: "tests/x.test.ts", name: "x works" }], assertions: [{ symbol: "src/s.ts#f", assertion: assertion("a1") }] });
	});
});

describe("standingOf, for an Intent of a task", () => {
	it("also leaves the task's reference checks standing", () => {
		const intent = { id: "i1", acceptance: [check("tests/x.test.ts", "x works")], premises: [] };
		expect(standingOf(intent, [{ file: "premise/hidden-tests/t09-thing.test.ts", name: "x works" }]).tests).toEqual([
			{ file: "tests/x.test.ts", name: "x works" },
			{ file: "premise/hidden-tests/t09-thing.test.ts", name: "x works" },
		]);
	});
});

describe("planStanding", () => {
	it("holds a lander to a landed Intent's reference checks only on a trunk that has that Intent's work", () => {
		const REFERENCE = "premise/hidden-tests/t09-thing.test.ts";
		const landed: Standing = { intentId: "ilandedx1", tests: [{ file: "tests/x.test.ts", name: "x works" }, { file: REFERENCE, name: "x works" }], assertions: [{ symbol: "src/s.ts#f", assertion: assertion("a1") }] };
		// The reference file is on trunk from the start, before anything has landed. A fork taken then does not have x's work.
		const before = { [REFERENCE]: "reference", "src/s.ts": "code" };
		expect(planStanding([landed], lander, before, before)).toEqual({ tests: [], tampered: [], assertions: [] });
		const after = { ...before, "tests/x.test.ts": "x tests" };
		const plan = planStanding([landed], lander, after, after);
		expect(plan.tests.map((test) => test.file)).toEqual(["tests/x.test.ts", REFERENCE]);
		expect(plan.assertions).toHaveLength(1);
		// Changing the reference file of landed work counts as tampering, like changing its test file.
		expect(planStanding([landed], lander, after, { ...after, [REFERENCE]: "weakened" }).tampered.map((test) => test.file)).toEqual([REFERENCE]);
	});


	it("runs every landed Intent's tests and assertions on the merged files", () => {
		const plan = planStanding([X, Y], lander, trunk, { ...trunk, "tests/l.test.ts": "new" });
		expect(plan.tests.map((test) => [test.intentId, test.name])).toEqual([["ilandedx1", "x works"], ["ilandedx1", "x still works"], ["ilandedy1", "y works"]]);
		expect(plan.tampered).toEqual([]);
		expect(plan.assertions.map((item) => item.runId)).toEqual(["landed:ilandedx1:a1"]);
		expect(standingRequest(plan)).toEqual({ tests: [{ file: "tests/x.test.ts", name: "x works" }, { file: "tests/x.test.ts", name: "x still works" }, { file: "tests/y.test.ts", name: "y works" }], assertions: [{ ...assertion("a1", "f throws"), id: "landed:ilandedx1:a1" }] });
	});

	it("counts a landed test whose file the lander edited or deleted as tampered, without running it", () => {
		const edited = planStanding([X, Y], lander, trunk, { ...trunk, "tests/x.test.ts": "weakened" });
		expect(edited.tampered.map((test) => test.name)).toEqual(["x works", "x still works"]);
		expect(edited.tests.map((test) => test.name)).toEqual(["y works"]);
		const { "tests/y.test.ts": _gone, ...withoutY } = trunk;
		expect(planStanding([Y], lander, trunk, withoutY).tampered.map((test) => test.name)).toEqual(["y works"]);
	});

	it("ignores checks that are not about this trunk, the lander's own entry, and tests it already runs itself", () => {
		const elsewhere: Standing = { intentId: "iother001", tests: [{ file: "tests/not-here.test.ts", name: "n" }], assertions: [{ symbol: "s", assertion: assertion("a9") }] };
		expect(planStanding([elsewhere], lander, trunk, trunk)).toEqual({ tests: [], tampered: [], assertions: [] });
		expect(planStanding([{ ...X, intentId: "ilander01" }], lander, trunk, trunk)).toEqual({ tests: [], tampered: [], assertions: [] });
		const same = { id: "ilander01", acceptance: [check("tests/x.test.ts", "x works")] };
		expect(planStanding([X], same, trunk, trunk).tests.map((test) => test.name)).toEqual(["x still works"]);
	});

	it("asks for a test once even if two landed Intents share it", () => {
		const twin: Standing = { ...Y, intentId: "ilandedz1" };
		expect(standingRequest(planStanding([Y, twin], lander, trunk, trunk)).tests).toEqual([{ file: "tests/y.test.ts", name: "y works" }]);
	});
});

describe("judgeStanding", () => {
	const plan = planStanding([X, Y], lander, trunk, trunk);
	const result = (failing: string[], failingAssertions: string[] = []) => ({
		tests: plan.tests.map((test) => ({ file: test.file, name: test.name, ok: !failing.includes(test.name), error: failing.includes(test.name) ? "expected a, got b" : undefined, ms: 1 })),
		assertions: plan.assertions.map((item) => ({ id: item.runId, ok: !failingAssertions.includes(item.runId), ms: 1 })),
	});

	it("passes when everything landed still passes", () => {
		expect(judgeStanding(plan, result([]))).toEqual({ failures: [], retired: [] });
	});

	it("names the landed Intent whose acceptance check fails, and what it relied on", () => {
		const verdict = judgeStanding(plan, result(["x works"], ["landed:ilandedx1:a1"]));
		expect(verdict.failures).toEqual([{ intentId: "ilandedx1", tests: [{ name: "x works", error: "expected a, got b" }], relied: ["f throws"] }]);
		expect(verdict.retired).toEqual([]);
		expect(describeStandingFailure(verdict.failures)).toBe('Breaks landed Intent ilandedx1: its acceptance check "x works" fails (expected a, got b). It relied on: f throws.');
	});

	it("retires an assertion that no longer holds when the Intent's acceptance checks still pass", () => {
		expect(judgeStanding(plan, result([], ["landed:ilandedx1:a1"]))).toEqual({ failures: [], retired: [{ intentId: "ilandedx1", assertionId: "a1", description: "f throws" }] });
	});

	it("fails tampered tests without their having run", () => {
		const tampered = planStanding([X], lander, trunk, { ...trunk, "tests/x.test.ts": "weakened" });
		const verdict = judgeStanding(tampered, { tests: [], assertions: [{ id: "landed:ilandedx1:a1", ok: true, ms: 1 }] });
		expect(verdict.failures).toEqual([{ intentId: "ilandedx1", tests: [{ name: "x works", error: TAMPERED }, { name: "x still works", error: TAMPERED }], relied: [] }]);
	});

	it("says how many other landed Intents break", () => {
		const verdict = judgeStanding(plan, result(["x works", "y works"]));
		expect(describeStandingFailure(verdict.failures)).toMatch(/^Breaks landed Intent ilandedx1: .*\(1 more landed Intent also break\.\)$/);
		expect(describeStandingFailure([])).toBe("");
	});
});

describe("MemoryStandingStore", () => {
	it("adds, lists and retires", () => {
		const store = new MemoryStandingStore();
		store.add(X);
		store.add(Y);
		expect(store.all()).toEqual([X, Y]);
		store.retire("ilandedx1", ["a1"]);
		expect(store.all()[0]).toEqual({ ...X, assertions: [] });
		store.retire("inobody", ["a1"]);
		expect(standingAssertionId("i1", "a1")).toBe("landed:i1:a1");
	});
});
