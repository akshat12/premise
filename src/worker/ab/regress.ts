// Counting behavioural regressions that reach trunk. Every demo task has reference checks, written
// in advance and out of the agents' reach (premise/hidden-tests/<task>.test.ts). A task whose
// checks use a stand-in for some part of the system also has a probe (premise/probes/<task>.test.ts)
// that goes end to end through the real code; no landing rule runs the probes. Once a task's Intent
// has landed, its reference checks and its probe should pass on trunk and go on passing. One that
// is red after a landing is a regression that reached trunk: either the work landed broken, or a
// later landing broke it. Pure.
import type { TaskDef, TaskId } from "../../shared/types";
import { referenceFile, testNames } from "../gate/suite";
import type { FileMap } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";

export const hiddenTestFile = referenceFile;
export const probeFile = (taskId: TaskId) => `premise/probes/${taskId}.test.ts`;
export const testKey = (file: string, name: string) => `${file}#${name}`;

/**
 * The reference checks and probes of the tasks that have landed, for the files given. A task with
 * no reference file or no probe contributes none of that kind.
 */
export function hiddenTests(tasks: readonly Pick<TaskDef, "id" | "acceptance">[], landed: ReadonlySet<TaskId> | readonly TaskId[], files: FileMap): RunRequest["tests"] {
	const done = new Set(landed);
	return tasks.flatMap((task) => {
		if (!done.has(task.id)) {
			return [];
		}
		const file = hiddenTestFile(task.id);
		const probe = probeFile(task.id);
		return [...(files[file] !== undefined ? task.acceptance.map((check) => ({ file, name: check.testName })) : []), ...testNames(files[probe] ?? "").map((name) => ({ file: probe, name }))];
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
