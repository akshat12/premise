// Runs the test files with Node (through tsx). For people and CI; the Premise gate runs the same
// files inside a Dynamic Worker instead.
//
//   npx tsx premise/run-tests.ts                      every tests/*.test.ts
//   npx tsx premise/run-tests.ts tests/login.test.ts  just these files
//   npx tsx premise/run-tests.ts --json               machine-readable results
//
// This repo is typechecked without Node's types, so the few Node things used here are declared by hand.
import type { Tests } from "./assert.js";

declare const process: { argv: string[]; exitCode?: number; cwd(): string };
declare const console: { log(...args: unknown[]): void };

interface TestResult {
	file: string;
	name: string;
	ok: boolean;
	error?: string;
}

// The specifiers are held in variables so the compiler does not look for Node's type declarations.
const fsModule = "node:fs";
const urlModule = "node:url";
const { readdirSync } = (await import(fsModule)) as { readdirSync(path: string): string[] };
const { pathToFileURL } = (await import(urlModule)) as { pathToFileURL(path: string): { href: string } };

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const requested = args.filter((arg) => !arg.startsWith("--"));
const files =
	requested.length > 0
		? requested
		: readdirSync("tests")
				.filter((name) => name.endsWith(".test.ts"))
				.sort()
				.map((name) => `tests/${name}`);

const results: TestResult[] = [];
for (const file of files) {
	let tests: Tests;
	try {
		const module = (await import(pathToFileURL(`${process.cwd()}/${file}`).href)) as { tests?: Tests };
		if (module.tests === undefined) {
			throw new Error("the file does not export `tests`");
		}
		tests = module.tests;
	} catch (error) {
		results.push({ file, name: "(load)", ok: false, error: error instanceof Error ? error.message : String(error) });
		continue;
	}
	for (const [name, run] of Object.entries(tests)) {
		try {
			await run();
			results.push({ file, name, ok: true });
		} catch (error) {
			results.push({ file, name, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

const failed = results.filter((result) => !result.ok);
if (asJson) {
	console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }));
} else {
	for (const file of files) {
		const forFile = results.filter((result) => result.file === file);
		const bad = forFile.filter((result) => !result.ok);
		console.log(`${bad.length === 0 ? "PASS" : "FAIL"}  ${file}  (${forFile.length - bad.length}/${forFile.length})`);
		for (const result of bad) {
			console.log(`      ✗ ${result.name}: ${result.error}`);
		}
	}
	console.log(`\n${results.length - failed.length} of ${results.length} tests passed in ${files.length} files`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
