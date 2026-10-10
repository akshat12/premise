// Counting behavioural regressions that reach trunk. Every demo task has a reference test,
// written in advance and hidden from the agents (premise/hidden-tests/<task>.test.ts). Once a
// task's Intent has landed, its reference tests should pass on trunk and go on passing. One that
// is red after a landing is a regression that reached trunk: either the work landed broken, or a
// later landing broke it. Pure.
import type { TaskDef, TaskId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";

export const hiddenTestFile = (taskId: TaskId) => `premise/hidden-tests/${taskId}.test.ts`;
export const testKey = (file: string, name: string) => `${file}#${name}`;

/** The reference tests of the tasks that have landed, for the files given. A task with no reference file contributes none. */
export function hiddenTests(tasks: readonly Pick<TaskDef, "id" | "acceptance">[], landed: ReadonlySet<TaskId> | readonly TaskId[], files: FileMap): RunRequest["tests"] {
	const done = new Set(landed);
	return tasks.flatMap((task) => {
		const file = hiddenTestFile(task.id);
		return done.has(task.id) && files[file] !== undefined ? task.acceptance.map((check) => ({ file, name: check.testName })) : [];
	});
}

/** The keys of the tests that failed. If nothing could be loaded, every test asked for is red. */
export function redTests(asked: RunRequest["tests"], run: Pick<RunResult, "tests" | "loadError">): string[] {
	if (run.loadError !== undefined) {
		return asked.map((test) => testKey(test.file, test.name));
	}
	return run.tests.filter((test) => !test.ok).map((test) => testKey(test.file, test.name));
}

/** Tests that are red now and were not after the previous landing. Each is one regression that reached trunk. */
export function newlyRed(before: ReadonlySet<string> | readonly string[], now: readonly string[]): string[] {
	const was = new Set(before);
	return now.filter((key) => !was.has(key));
}
