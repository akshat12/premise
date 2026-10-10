// Standing checks: what landed work still needs from trunk.
//
// Invalidation protects Intents that are in flight when something lands. It cannot help an Intent
// that landed first: if `t02` (which relies on verifySession throwing) lands and then `t01` (which
// stops it throwing) arrives, nothing of t02's is in flight to turn red. So when an Intent lands,
// its acceptance checks and its assertions stay behind as standing checks, and the gate runs them
// for every later landing:
//   - a lander that makes a landed Intent's acceptance check fail does not land. It goes stale,
//     told which landed Intent it broke and what that Intent relied on, and is re-derived. The
//     re-derive can keep its own change and repair the code that depended on the old behaviour.
//   - a lander may not edit or delete a landed acceptance test. They are as immutable as its own.
//   - a landed Intent's assertion that stops holding while its acceptance checks still pass is
//     retired: the lander changed the behaviour and demonstrably kept the dependent work working.
// Pure, apart from the store interface the Landing object backs with SQLite.
import type { Assertion, Intent, IntentId, SymbolId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";

export interface Standing {
	intentId: IntentId;
	tests: { file: string; name: string }[];
	assertions: { symbol: SymbolId; assertion: Assertion }[];
}

export interface StandingStore {
	all(): Standing[] | Promise<Standing[]>;
	add(standing: Standing): void | Promise<void>;
	/** Drops assertions of a landed Intent that no longer hold on trunk. */
	retire(intentId: IntentId, assertionIds: readonly string[]): void | Promise<void>;
}

export class MemoryStandingStore implements StandingStore {
	private entries = new Map<IntentId, Standing>();
	all = (): Standing[] => [...this.entries.values()].map((entry) => structuredClone(entry));
	add(standing: Standing): void {
		this.entries.set(standing.intentId, structuredClone(standing));
	}
	retire(intentId: IntentId, assertionIds: readonly string[]): void {
		const entry = this.entries.get(intentId);
		if (entry !== undefined) {
			entry.assertions = entry.assertions.filter((item) => !assertionIds.includes(item.assertion.id));
		}
	}
}

/** What an Intent leaves standing when it lands: its acceptance tests and the assertions that still hold. */
export function standingOf(intent: Pick<Intent, "id" | "acceptance" | "premises">): Standing {
	return {
		intentId: intent.id,
		tests: intent.acceptance.map((check) => ({ file: check.testFile, name: check.testName })),
		assertions: intent.premises.flatMap((premise) => (premise.source === "asserted" && premise.state === "holding" && premise.assertion !== undefined ? [{ symbol: premise.symbol, assertion: premise.assertion }] : [])),
	};
}

/** The run id of a landed Intent's assertion, distinct from the lander's own assertion ids. */
export const standingAssertionId = (intentId: IntentId, assertionId: string) => `landed:${intentId}:${assertionId}`;

export interface StandingPlan {
	/** Standing tests to run on the merged files. */
	tests: { intentId: IntentId; file: string; name: string }[];
	/** Standing tests that fail without running, because the lander changed or removed their file. */
	tampered: { intentId: IntentId; file: string; name: string }[];
	assertions: { intentId: IntentId; symbol: SymbolId; assertion: Assertion; runId: string }[];
}

/**
 * Which standing checks apply to a landing. A check applies only if its test file is on the trunk
 * being landed on (so checks recorded against some other trunk are ignored), and never to the
 * Intent that owns it. Tests the lander already runs as its own are not repeated.
 */
export function planStanding(standing: readonly Standing[], lander: Pick<Intent, "id" | "acceptance">, trunk: FileMap, merged: FileMap): StandingPlan {
	const own = new Set(lander.acceptance.map((check) => `${check.testFile}\n${check.testName}`));
	const plan: StandingPlan = { tests: [], tampered: [], assertions: [] };
	for (const entry of standing) {
		if (entry.intentId === lander.id) {
			continue;
		}
		const tests = entry.tests.filter((test) => trunk[test.file] !== undefined && !own.has(`${test.file}\n${test.name}`));
		for (const test of tests) {
			(merged[test.file] === trunk[test.file] ? plan.tests : plan.tampered).push({ intentId: entry.intentId, ...test });
		}
		// An Intent's assertions are only meaningful alongside its tests on this trunk.
		if (entry.tests.some((test) => trunk[test.file] !== undefined)) {
			for (const item of entry.assertions) {
				plan.assertions.push({ intentId: entry.intentId, ...item, runId: standingAssertionId(entry.intentId, item.assertion.id) });
			}
		}
	}
	return plan;
}

/** The extra tests and assertions to add to the lander's own run. */
export function standingRequest(plan: StandingPlan): Pick<RunRequest, "tests" | "assertions"> {
	const seen = new Set<string>();
	const tests: RunRequest["tests"] = [];
	for (const test of plan.tests) {
		const key = `${test.file}\n${test.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			tests.push({ file: test.file, name: test.name });
		}
	}
	return { tests, assertions: plan.assertions.map((item) => ({ ...item.assertion, id: item.runId })) };
}

export interface StandingFailure {
	/** The landed Intent whose work this landing would break. */
	intentId: IntentId;
	tests: { name: string; error: string }[];
	/** What that Intent said it relied on and which no longer holds: the likely reason. */
	relied: string[];
}

export interface StandingVerdict {
	/** Landed Intents this landing would break. Empty means it may land. */
	failures: StandingFailure[];
	/** Assertions of landed Intents that no longer hold although their acceptance checks pass. Retired if this lands. */
	retired: { intentId: IntentId; assertionId: string; description: string }[];
}

export const TAMPERED = "this Intent changed or removed the test file of a landed acceptance check; those tests cannot be edited";

/** Reads the standing part of a run's results. Pure. */
export function judgeStanding(plan: StandingPlan, run: Pick<RunResult, "tests" | "assertions">): StandingVerdict {
	const failedTests = new Map<string, string>();
	for (const test of run.tests) {
		if (!test.ok) {
			failedTests.set(`${test.file}\n${test.name}`, test.error ?? "failed");
		}
	}
	const failedAssertions = new Set(run.assertions.filter((result) => !result.ok).map((result) => result.id));
	const byIntent = new Map<IntentId, StandingFailure>();
	const failure = (intentId: IntentId) => {
		let entry = byIntent.get(intentId);
		if (entry === undefined) {
			entry = { intentId, tests: [], relied: [] };
			byIntent.set(intentId, entry);
		}
		return entry;
	};
	for (const test of plan.tampered) {
		failure(test.intentId).tests.push({ name: test.name, error: TAMPERED });
	}
	for (const test of plan.tests) {
		const error = failedTests.get(`${test.file}\n${test.name}`);
		if (error !== undefined) {
			failure(test.intentId).tests.push({ name: test.name, error });
		}
	}
	const retired: StandingVerdict["retired"] = [];
	for (const item of plan.assertions) {
		if (!failedAssertions.has(item.runId)) {
			continue;
		}
		const broken = byIntent.get(item.intentId);
		if (broken !== undefined) {
			broken.relied.push(item.assertion.description);
		} else {
			retired.push({ intentId: item.intentId, assertionId: item.assertion.id, description: item.assertion.description });
		}
	}
	return { failures: [...byIntent.values()], retired };
}

/** One line for the status note and the re-derive briefing. */
export function describeStandingFailure(failures: readonly StandingFailure[]): string {
	const first = failures[0];
	if (first === undefined) {
		return "";
	}
	const test = first.tests[0];
	const more = failures.length - 1;
	return [
		`Breaks landed Intent ${first.intentId}: its acceptance check "${test?.name ?? "?"}" fails (${test?.error ?? "failed"}).`,
		first.relied.length > 0 ? ` It relied on: ${first.relied.join("; ")}.` : "",
		more > 0 ? ` (${more} more landed Intent${more === 1 ? "" : "s"} also break.)` : "",
	].join("");
}
