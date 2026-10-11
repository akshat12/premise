import { describe, expect, it } from "vitest";
import { demoFiles } from "../testing/demo";
import { referenceChecks, referenceFile, suiteTests, testNames } from "./suite";

describe("testNames", () => {
	it("reads the keys of the exported tests object", () => {
		const source = `import * as assert from "../premise/assert.js";\nconst helper = () => 1;\nexport const tests: Tests = {\n\t"adds two numbers": () => {},\n\tplain: () => {},\n\t"with: punctuation, and 'quotes'": async () => {},\n};\n`;
		expect(testNames(source)).toEqual(["adds two numbers", "plain", "with: punctuation, and 'quotes'"]);
	});

	it("sees through `satisfies` and `as`, and ignores other exports", () => {
		expect(testNames('export const other = { "not a test": 1 };\nexport const tests = { "one": () => {} } satisfies Tests;\n')).toEqual(["one"]);
		expect(testNames('export const tests = ({ "two": () => {} }) as Tests;\n')).toEqual(["two"]);
	});

	it("gives nothing for a file with no tests object, or one that does not parse", () => {
		expect(testNames("export const helper = 1;\n")).toEqual([]);
		expect(testNames("export const tests = {{{")).toEqual([]);
		expect(testNames("const tests = { hidden: () => {} };\n")).toEqual([]);
	});
});

describe("suiteTests", () => {
	it("lists every test under tests/ in a stable order, and nothing from anywhere else", () => {
		const files = { "tests/b.test.ts": 'export const tests = { "b1": () => {} };', "tests/a.test.ts": 'export const tests = { "a1": () => {}, "a2": () => {} };', "tests/support.ts": 'export const tests = { "no": () => {} };', "premise/hidden-tests/t.test.ts": 'export const tests = { "hidden": () => {} };', "src/x.test.ts": 'export const tests = { "elsewhere": () => {} };' };
		expect(suiteTests(files)).toEqual([
			{ file: "tests/a.test.ts", name: "a1" },
			{ file: "tests/a.test.ts", name: "a2" },
			{ file: "tests/b.test.ts", name: "b1" },
		]);
		expect(suiteTests(files, [{ file: "tests/a.test.ts", name: "a2" }]).map((test) => test.name)).toEqual(["a1", "b1"]);
	});

	it("finds the demo repo's whole suite", () => {
		const suite = suiteTests(demoFiles());
		expect(suite.length).toBeGreaterThanOrEqual(80);
		expect(new Set(suite.map((test) => test.file)).size).toBeGreaterThanOrEqual(8);
		expect(suite).toContainEqual({ file: "tests/session.test.ts", name: "verifySession returns the session for a valid token" });
	});
});

describe("referenceChecks", () => {
	it("is every test in the task's reference file on trunk, whatever the Intent calls its own", () => {
		const file = referenceFile("t09-thing");
		expect(file).toBe("premise/hidden-tests/t09-thing.test.ts");
		expect(referenceChecks({ taskId: "t09-thing" }, { [file]: 'export const tests = { "first": () => {}, "second": () => {} };' })).toEqual([
			{ file, name: "first" },
			{ file, name: "second" },
		]);
	});

	it("is empty when trunk has no reference file for the task", () => {
		expect(referenceChecks({ taskId: "workload" }, {})).toEqual([]);
	});

	it("covers every acceptance check of every demo task", () => {
		const files = demoFiles();
		const tasks = JSON.parse(files["premise/tasks.json"] ?? "[]") as { id: string; acceptance: { testName: string }[] }[];
		expect(tasks).toHaveLength(12);
		for (const task of tasks) {
			expect(referenceChecks({ taskId: task.id }, files).map((test) => test.name).sort(), task.id).toEqual(task.acceptance.map((check) => check.testName).sort());
		}
	});
});
