// Proves that demo-repo behaves the way the Premise demo needs. Run: npx tsx scripts/check-scenario.ts
//
// Each check builds a copy of demo-repo with some reference patches applied (premise/reference/*.patch.ts,
// each a FileChanges object), then typechecks it and runs tests in it. The process exits non-zero if any
// outcome differs from what is expected.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type FileChanges = Record<string, string | null>;
interface AcceptanceCheck { id: string; description: string; testFile: string; testName: string }
interface TaskDef { id: string; title: string; goal: string; acceptance: AcceptanceCheck[] }
interface Assertion { id: string; description: string; code: string; imports: string[] }
interface TestResult { file: string; name: string; ok: boolean; error?: string }

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "demo-repo");
const tsc = join(root, "node_modules/typescript/bin/tsc");
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const tasks = JSON.parse(readFileSync(join(repo, "premise/tasks.json"), "utf8")) as TaskDef[];
const assertions = JSON.parse(readFileSync(join(repo, "premise/assertions.json"), "utf8")) as Assertion[];

function run(args: string[], cwd: string): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
			resolve({ code, out: `${stdout}${stderr}` });
		});
	});
}

async function loadPatch(id: string): Promise<FileChanges> {
	const module = (await import(pathToFileURL(join(repo, `premise/reference/${id}.patch.ts`)).href)) as { default: FileChanges };
	return module.default;
}

const scratch = mkdtempSync(join(tmpdir(), "premise-scenario-"));

/** A copy of demo-repo with `patches` applied in order. Later patches must not touch the same paths as earlier ones. */
async function tree(name: string, patchIds: string[]): Promise<string> {
	const dir = join(scratch, name);
	cpSync(repo, dir, { recursive: true, filter: (source) => !source.includes("node_modules") && !source.endsWith(".git") });
	const touched = new Set<string>();
	for (const id of patchIds) {
		for (const [path, content] of Object.entries(await loadPatch(id))) {
			if (touched.has(path)) {
				throw new Error(`${name}: patches overlap on ${path}, so stacking them is not a plain textual merge`);
			}
			touched.add(path);
			if (content === null) {
				rmSync(join(dir, path), { force: true });
			} else {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), content);
			}
		}
	}
	return dir;
}

async function typecheck(dir: string): Promise<{ ok: boolean; out: string }> {
	const result = await run([tsc, "--noEmit", "-p", dir], dir);
	return { ok: result.code === 0, out: result.out.trim() };
}

async function runTests(dir: string, files: string[] = []): Promise<TestResult[]> {
	const result = await run([tsx, "premise/run-tests.ts", "--json", ...files], dir);
	const line = result.out.trim().split("\n").at(-1) ?? "";
	try {
		return (JSON.parse(line) as { results: TestResult[] }).results;
	} catch {
		throw new Error(`could not read test results in ${dir}:\n${result.out}`);
	}
}

/** Runs a task's acceptance checks: the named tests in the test file the task's agent adds. */
async function acceptance(dir: string, taskId: string): Promise<{ passed: string[]; failed: string[]; reasons: string[] }> {
	const task = tasks.find((candidate) => candidate.id === taskId);
	if (task === undefined) {
		throw new Error(`no task ${taskId} in tasks.json`);
	}
	const results = await runTests(dir, [...new Set(task.acceptance.map((check) => check.testFile))]);
	const passed: string[] = [];
	const failed: string[] = [];
	const reasons: string[] = [];
	for (const check of task.acceptance) {
		const result = results.find((candidate) => candidate.file === check.testFile && candidate.name === check.testName);
		(result?.ok ? passed : failed).push(check.id);
		if (!result?.ok) {
			reasons.push(`${check.id} "${check.testName}": ${result?.error ?? "test not found"}`);
		}
	}
	return { passed, failed, reasons };
}

/** Evaluates a premise assertion against a tree by running it as a one-off test file there. */
async function assertionHolds(dir: string, assertion: Assertion): Promise<boolean> {
	const imports = assertion.imports.map((path, index) => `import * as m${index} from "../${path.replace(/\.ts$/, ".js")}";`).join("\n");
	const scope = ["assert", ...assertion.imports.map((_, index) => `...m${index}`)].join(", ");
	const file = "tests/zz-assertion.test.ts";
	writeFileSync(
		join(dir, file),
		`import * as assert from "../premise/assert.js";\n${imports}\nconst scope: Record<string, unknown> = { ${scope} };\n` +
			`export const tests = { assertion: () => { new Function(...Object.keys(scope), ${JSON.stringify(assertion.code)})(...Object.values(scope)); } };\n`,
	);
	const results = await runTests(dir, [file]);
	rmSync(join(dir, file));
	return results.length === 1 && results[0]?.ok === true;
}

interface Outcome { label: string; expected: string; actual: string; notes: string[] }
const outcomes: Outcome[] = [];
function expect(label: string, expected: string, actual: string, notes: string[] = []): void {
	outcomes.push({ label, expected, actual, notes });
}
const verdict = (types: boolean, checks: { passed: string[]; failed: string[] }) =>
	`tsc ${types ? "passes" : "FAILS"}, acceptance ${checks.failed.length === 0 ? "passes" : "FAILS"} (${checks.passed.length}/${checks.passed.length + checks.failed.length})`;
const count = (taskId: string) => tasks.find((task) => task.id === taskId)?.acceptance.length ?? 0;

async function checkPatched(label: string, name: string, patchIds: string[], taskId: string, expectAcceptance: "passes" | "FAILS", alsoWholeSuite = false): Promise<void> {
	const dir = await tree(name, patchIds);
	const [types, checks] = await Promise.all([typecheck(dir), acceptance(dir, taskId)]);
	const total = count(taskId);
	const expectedCount = expectAcceptance === "passes" ? `${total}/${total}` : undefined;
	const actual = verdict(types.ok, checks);
	// For an expected failure, show why each check failed: it must be the behaviour, not a broken test file.
	expect(
		label,
		expectedCount ? `tsc passes, acceptance passes (${expectedCount})` : "tsc passes, acceptance FAILS",
		expectAcceptance === "FAILS" ? actual.replace(/ \(\d+\/\d+\)$/, "") : actual,
		checks.reasons,
	);
	if (!types.ok) {
		console.error(`${label}\n${types.out}`);
	}
	if (alsoWholeSuite) {
		const all = await runTests(dir);
		const bad = all.filter((result) => !result.ok);
		expect(`${label}: every test in the repo`, "all pass", bad.length === 0 ? "all pass" : `${bad.length} FAIL: ${bad.map((result) => `${result.file} > ${result.name}`).join("; ")}`);
	}
}

try {
	// 0. The untouched repo.
	const baseDir = await tree("base", []);
	const [baseTypes, baseTests] = await Promise.all([typecheck(baseDir), runTests(baseDir)]);
	expect("0. trunk as it is", "tsc passes, all tests pass", `tsc ${baseTypes.ok ? "passes" : "FAILS"}, ${baseTests.every((result) => result.ok) ? "all tests pass" : "tests FAIL"}`);

	// The four outcomes the demo depends on, for each of the three Intents that rely on the throw.
	// t02 and t03 are caught by their own tests after the rebase. t11 is the one tests do not catch:
	// its checks use a stand-in for the session check, so they still pass, and only the probe (which
	// nothing runs before landing) and the premise assertion see that the real path is broken.
	await checkPatched("1. t01 on trunk", "t01", ["t01"], "t01-null-expired", "passes", true);
	const relying: [string, string, "passes" | "FAILS"][] = [["t02", "t02-audit-expired", "FAILS"], ["t03", "t03-expired-metrics", "FAILS"], ["t11", "t11-expired-rate-limit", "passes"]];
	await Promise.all(
		relying.flatMap(([patch, task, rebased]) => [
			checkPatched(`2. ${patch} on trunk`, `${patch}-on-trunk`, [patch], task, "passes", true),
			checkPatched(`3. ${patch} on top of t01 (textual rebase)`, `${patch}-rebased`, ["t01", patch], task, rebased, rebased === "passes"),
			checkPatched(`4. ${patch}-rederived on top of t01`, `${patch}-rederived`, ["t01", `${patch}-rederived`], task, "passes", true),
		]),
	);
	const PROBE = "premise/probes/t11-expired-rate-limit.test.ts";
	const probe = async (label: string, name: string, patchIds: string[], expected: "passes" | "FAILS") => {
		const results = await runTests(await tree(name, patchIds), [PROBE]);
		const bad = results.filter((result) => !result.ok);
		expect(label, expected === "passes" ? "probe passes" : "probe FAILS", results.length > 0 && bad.length === 0 ? "probe passes" : "probe FAILS", bad.map((result) => `"${result.name}": ${result.error ?? ""}`));
	};
	await Promise.all([
		probe("4a. t11 on trunk: the end-to-end probe", "t11-probe-trunk", ["t11"], "passes"),
		probe("4b. t11 on top of t01 (textual rebase): the end-to-end probe", "t11-probe-rebased", ["t01", "t11"], "FAILS"),
		probe("4c. t11-rederived on top of t01: the end-to-end probe", "t11-probe-rederived", ["t01", "t11-rederived"], "passes"),
	]);

	// The control: t04 reads verifySession but relies only on its types, so it is fine either way.
	await Promise.all([
		checkPatched("5. t04 on trunk (control)", "t04-on-trunk", ["t04"], "t04-session-ttl-header", "passes", true),
		checkPatched("5. t04 on top of t01 (control, textual rebase)", "t04-rebased", ["t01", "t04"], "t04-session-ttl-header", "passes", true),
	]);

	// The premise itself: the assertion holds on trunk and breaks once t01 lands.
	const sessionThrows = assertions.find((assertion) => assertion.id === "a-session-throws");
	if (sessionThrows === undefined) {
		throw new Error("assertions.json has no a-session-throws");
	}
	const [onTrunk, afterT01] = await Promise.all([assertionHolds(baseDir, sessionThrows), assertionHolds(await tree("t01-assertion", ["t01"]), sessionThrows)]);
	expect("6. assertion a-session-throws on trunk", "holds", onTrunk ? "holds" : "BROKEN");
	expect("6. assertion a-session-throws after t01", "BROKEN", afterT01 ? "holds" : "BROKEN");

	// The ordinary tasks: each reference solution passes its own checks and breaks nothing else.
	const ordinary: [string, string][] = [
		["t05", "t05-tax-rounding"], ["t06", "t06-discount-stacking"], ["t07", "t07-role-check"], ["t08", "t08-profile-validation"],
		["t09", "t09-currency-format"], ["t10", "t10-invoice-numbering"], ["t12", "t12-password-policy"],
	];
	await Promise.all(ordinary.map(([patch, task]) => checkPatched(`7. ${patch} on trunk`, `${patch}-on-trunk`, [patch], task, "passes", true)));

	// Every task has a reference solution and a hidden test, and no acceptance test exists on trunk yet.
	const patches = readdirSync(join(repo, "premise/reference")).map((name) => name.replace(".patch.ts", ""));
	const hidden = readdirSync(join(repo, "premise/hidden-tests")).map((name) => name.replace(".test.ts", ""));
	const trunkTests = new Set(readdirSync(join(repo, "tests")).map((name) => `tests/${name}`));
	const missing = tasks.filter((task) => !patches.includes(task.id.slice(0, 3)) || !hidden.includes(task.id));
	const preexisting = tasks.flatMap((task) => task.acceptance).filter((check) => trunkTests.has(check.testFile));
	expect("8. tasks.json", "12 tasks, each with a reference patch and a hidden test, none already done", `${tasks.length} tasks, ${missing.length === 0 ? "each with a reference patch and a hidden test" : `MISSING for ${missing.map((task) => task.id).join(", ")}`}, ${preexisting.length === 0 ? "none already done" : "some acceptance tests ALREADY on trunk"}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

outcomes.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
let failures = 0;
for (const outcome of outcomes) {
	const ok = outcome.expected === outcome.actual;
	failures += ok ? 0 : 1;
	console.log(`${ok ? "ok  " : "BAD "} ${outcome.label}: ${outcome.actual}${ok ? "" : `   (expected: ${outcome.expected})`}`);
	for (const note of outcome.notes) {
		console.log(`        ${note}`);
	}
}
console.log(failures === 0 ? `\nScenario holds: ${outcomes.length} of ${outcomes.length} outcomes as expected.` : `\n${failures} of ${outcomes.length} outcomes are NOT as expected.`);
process.exit(failures === 0 ? 0 : 1);
