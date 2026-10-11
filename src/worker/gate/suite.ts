// What the gate runs besides an Intent's own acceptance tests. Pure.
//
//   - Reference checks. The agent writes the bodies of its own acceptance tests, so those alone
//     would let it mark its own exam. Each task therefore also has reference checks, written
//     with the task and kept on trunk under premise/hidden-tests/, which no agent can read or
//     write. The gate runs trunk's copy of them against the Intent's work.
//   - Trunk's suite. Every test already on trunk under tests/ runs against the merged files, so
//     a landing cannot break behaviour that some earlier test pins down.
import type { Intent, TaskId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import ts from "../ts";

export interface TestRef {
	file: string;
	name: string;
}

export const referenceFile = (taskId: TaskId) => `premise/hidden-tests/${taskId}.test.ts`;
export const testKey = (test: TestRef) => `${test.file}\n${test.name}`;

const cache = new Map<string, string[]>();

/** The names of the tests a file declares: the keys of its exported `tests` object. Empty if it has none or does not parse. */
export function testNames(source: string): string[] {
	const cached = cache.get(source);
	if (cached !== undefined) {
		return cached;
	}
	const names: string[] = [];
	const file = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, false);
	for (const statement of file.statements) {
		if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
			continue;
		}
		for (const declaration of statement.declarationList.declarations) {
			let value = declaration.initializer;
			while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) {
				value = value.expression;
			}
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "tests" || value === undefined || !ts.isObjectLiteralExpression(value)) {
				continue;
			}
			for (const property of value.properties) {
				const name = property.name;
				if (name !== undefined && (ts.isStringLiteralLike(name) || ts.isIdentifier(name) || ts.isNumericLiteral(name))) {
					names.push(name.text);
				}
			}
		}
	}
	if (cache.size > 500) {
		cache.clear();
	}
	cache.set(source, names);
	return names;
}

/** An Intent's reference checks: every test in its task's reference file on trunk. None if trunk has no such file. */
export function referenceChecks(intent: Pick<Intent, "taskId">, trunk: FileMap): TestRef[] {
	const file = referenceFile(intent.taskId);
	return testNames(trunk[file] ?? "").map((name) => ({ file, name }));
}

export const isSuiteFile = (path: string) => path.startsWith("tests/") && path.endsWith(".test.ts");

/** Every test under tests/ in these files, in a stable order, leaving out the ones in `except` (already being run as something else). */
export function suiteTests(files: FileMap, except: readonly TestRef[] = []): TestRef[] {
	const skip = new Set(except.map(testKey));
	return Object.keys(files)
		.filter(isSuiteFile)
		.sort()
		.flatMap((file) => testNames(files[file] ?? "").map((name) => ({ file, name })))
		.filter((test) => !skip.has(testKey(test)));
}
