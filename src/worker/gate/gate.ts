// The gate, for one Intent: rebase onto trunk, typecheck, run the acceptance tests and the premise
// assertions, and only then commit to trunk. Everything it touches comes in through `GateDeps`, so
// the whole pipeline runs in a unit test with an in-memory repo.
import type { CommitSha, GateReport, Intent, SymbolId } from "../../shared/types";
import { type FileChanges, type FileMap, StaleHeadError } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";
import { diffSurface, type SurfaceMap, type TypecheckResult } from "../surface";
import { threeWayRebase } from "./rebase";
import { describeStandingFailure, judgeStanding, planStanding, type Standing, type StandingFailure, standingRequest, type StandingVerdict } from "./standing";

export interface GateDeps {
	snapshot(repo: string, ref: string): Promise<FileMap>;
	head(repo: string): Promise<CommitSha>;
	commitTrunk(expectedHead: CommitSha, changes: FileChanges, message: string): Promise<CommitSha>;
	typecheck(files: FileMap): TypecheckResult;
	surface(files: FileMap): { map: SurfaceMap };
	run(req: RunRequest): Promise<RunResult>;
	/** The repo acting as trunk. Defaults to "trunk". */
	trunk?: string;
}

export type GatePath = GateReport["path"];

export interface GateOptions {
	/** Do not run the premise assertions (the A/B baseline has none). */
	skipAssertions?: boolean;
	/** Do not run the acceptance tests (the A/B baseline lands on typecheck alone). */
	skipTests?: boolean;
	/** Run every check but do not commit. `report.ok` then means "would land"; `landedCommit` stays null. */
	dryRun?: boolean;
	/** What landed Intents left behind. Their acceptance checks must still pass for this to land (see standing.ts). */
	standing?: readonly Standing[];
}

export interface GateOutcome {
	report: GateReport;
	/** Exported symbols whose type surface changed or disappeared when this landed. Empty unless it landed. */
	changedSymbols: SymbolId[];
	/** Trunk's files after landing. Present only when it landed. */
	newTrunkFiles?: FileMap;
	/** Paths the textual rebase could not merge. */
	conflicts: string[];
	/** Trunk's head when the check started. Equal to `report.landedCommit` when the work was already on trunk. */
	trunkBefore: CommitSha;
	/** Landed Intents this would break. Non-empty means it did not land for that reason. */
	standingFailures: StandingFailure[];
	/** Assertions of landed Intents that this landing made untrue while keeping their acceptance checks passing. */
	retired: StandingVerdict["retired"];
}

const DEFAULT_TRUNK = "trunk";

/** The commit message for a landing: `intent <id>: <goal>` plus a trailer naming the Intent. */
export function landingMessage(intent: Pick<Intent, "id" | "goal">): string {
	const goal = (intent.goal.split("\n")[0] ?? "").trim();
	return `intent ${intent.id}: ${goal}\n\nPremise-Intent: ${intent.id}`;
}

/** What has to be written to turn `from` into `to`. */
export function changesBetween(from: FileMap, to: FileMap): FileChanges {
	const changes: FileChanges = {};
	for (const path of new Set([...Object.keys(from), ...Object.keys(to)])) {
		if (from[path] !== to[path]) {
			changes[path] = to[path] ?? null;
		}
	}
	return changes;
}

type Verdict = Pick<GateReport, "textConflict" | "typecheck" | "tests" | "assertions">;

// A step that did not run reports nothing passed: read a report top-down and stop at the first failure.
const NOT_RUN: Pick<GateReport, "tests" | "assertions"> = { tests: { passed: [], failed: [] }, assertions: { passed: [], failed: [] } };

function summarise(intent: Intent, run: RunResult): Pick<GateReport, "tests" | "assertions"> {
	const tests: GateReport["tests"] = { passed: [], failed: [] };
	for (const test of run.tests) {
		if (test.ok) {
			tests.passed.push(test.name);
		} else {
			tests.failed.push({ name: test.name, error: test.error ?? "failed" });
		}
	}
	const assertions: GateReport["assertions"] = { passed: [], failed: [] };
	for (const assertion of run.assertions) {
		if (assertion.ok) {
			assertions.passed.push(assertion.id);
		} else {
			assertions.failed.push({ id: assertion.id, error: assertion.error ?? "failed" });
		}
	}
	if (run.loadError !== undefined && tests.failed.length === 0 && assertions.failed.length === 0) {
		// Nothing could be loaded and there was nothing to pin the failure on: it still must not land.
		tests.failed.push({ name: intent.acceptance[0]?.testName ?? "(load)", error: run.loadError });
	}
	return { tests, assertions };
}

async function attempt(deps: GateDeps, intent: Intent, opts: GateOptions): Promise<Omit<GateOutcome, "report"> & { verdict: Verdict; passed: boolean; landedCommit: CommitSha | null }> {
	if (intent.headCommit === null) {
		throw new Error(`Intent ${intent.id} has nothing pushed to land`);
	}
	const trunk = deps.trunk ?? DEFAULT_TRUNK;
	const trunkHead = await deps.head(trunk);
	const [trunkFiles, base, head] = await Promise.all([deps.snapshot(trunk, trunkHead), deps.snapshot(intent.repo, intent.baseCommit), deps.snapshot(intent.repo, intent.headCommit)]);

	const rebased = threeWayRebase(base, head, trunkFiles);
	const stopped = { changedSymbols: [], conflicts: rebased.conflicts, passed: false, landedCommit: null, trunkBefore: trunkHead, standingFailures: [] as StandingFailure[], retired: [] as StandingVerdict["retired"] };
	if (rebased.conflicts.length > 0) {
		return { ...stopped, verdict: { textConflict: true, typecheck: { ok: false, errors: [] }, ...NOT_RUN } };
	}
	const merged = rebased.files;

	const checked = deps.typecheck(merged);
	const typecheck = { ok: checked.ok, errors: checked.errors };
	if (!checked.ok) {
		return { ...stopped, verdict: { textConflict: false, typecheck, ...NOT_RUN } };
	}

	const tests = opts.skipTests ? [] : intent.acceptance.map((check) => ({ file: check.testFile, name: check.testName }));
	const assertions = opts.skipAssertions ? [] : intent.premises.flatMap((premise) => (premise.source === "asserted" && premise.assertion !== undefined ? [premise.assertion] : []));
	// The checks landed Intents left behind run in the same isolate as the lander's own.
	const plan = planStanding(opts.standing ?? [], intent, trunkFiles, merged);
	const extra = standingRequest(plan);
	const nothingToRun = tests.length + assertions.length + extra.tests.length + extra.assertions.length === 0;
	const run: RunResult = nothingToRun ? { tests: [], assertions: [] } : await deps.run({ files: merged, tests: [...tests, ...extra.tests], assertions: [...assertions, ...extra.assertions] });
	// The report's test and assertion lists are the Intent's own; a landed check that fails is added to the failures.
	const ownRun: RunResult = { ...run, tests: run.tests.slice(0, tests.length), assertions: run.assertions.slice(0, assertions.length) };
	const ran = tests.length + assertions.length === 0 && run.loadError === undefined ? NOT_RUN : summarise(intent, ownRun);
	const standing = run.loadError === undefined ? judgeStanding(plan, { tests: run.tests.slice(tests.length), assertions: run.assertions.slice(assertions.length) }) : judgeStanding({ ...plan, tests: [], assertions: [] }, { tests: [], assertions: [] });
	const landedFailed = standing.failures.flatMap((failure) => failure.tests.map((test) => ({ name: test.name, error: `(acceptance check of landed Intent ${failure.intentId}) ${test.error}` })));
	const verdict: Verdict = { textConflict: false, typecheck, tests: { passed: ran.tests.passed, failed: [...ran.tests.failed, ...landedFailed] }, assertions: ran.assertions };
	if (verdict.tests.failed.length > 0 || verdict.assertions.failed.length > 0) {
		return { ...stopped, verdict, standingFailures: standing.failures };
	}

	if (opts.dryRun) {
		return { ...stopped, passed: true, verdict, retired: standing.retired };
	}
	const changes = changesBetween(trunkFiles, merged);
	// An Intent whose work is already on trunk has nothing to commit; trunk stays where it is.
	const landedCommit = Object.keys(changes).length === 0 ? trunkHead : await deps.commitTrunk(trunkHead, changes, landingMessage(intent));
	const moved = diffSurface(deps.surface(trunkFiles).map, deps.surface(merged).map);
	return { verdict, passed: true, landedCommit, changedSymbols: [...moved.changed, ...moved.removed].sort(), newTrunkFiles: merged, conflicts: [], trunkBefore: trunkHead, standingFailures: [], retired: standing.retired };
}

/**
 * Runs one Intent through the gate. It lands (`report.ok`, `report.landedCommit`) only if the
 * rebase is clean, the result typechecks, and every acceptance test and asserted premise passes.
 * If trunk moves while it is being checked, the whole thing runs once more against the new trunk.
 * With `opts.dryRun` nothing is committed and `report.ok` says whether it would have landed.
 */
export async function gateOne(deps: GateDeps, intent: Intent, path: GatePath, opts: GateOptions = {}): Promise<GateOutcome> {
	const started = Date.now();
	for (let tries = 0; ; tries++) {
		try {
			const { verdict, passed, landedCommit, ...rest } = await attempt(deps, intent, opts);
			const report: GateReport = { intentId: intent.id, path, ...verdict, ok: passed, landedCommit, durationMs: Date.now() - started };
			return { report, ...rest };
		} catch (error) {
			if (!(error instanceof StaleHeadError) || tries >= 1) {
				throw error;
			}
		}
	}
}

/** One line saying why an Intent did not get through the gate. Shown as the note on its status change. */
export function describeFailure(report: GateReport, conflicts: readonly string[] = [], standingFailures: readonly StandingFailure[] = []): string {
	if (report.textConflict) {
		return `Text conflict with trunk in ${conflicts.join(", ") || "a file both changed"}`;
	}
	if (!report.typecheck.ok) {
		const extra = report.typecheck.errors.length - 1;
		return `Typecheck failed on the new trunk: ${report.typecheck.errors[0] ?? "unknown error"}${extra > 0 ? ` (and ${extra} more)` : ""}`;
	}
	const assertion = report.assertions.failed[0];
	if (assertion !== undefined) {
		return `Premise ${assertion.id} no longer holds: ${assertion.error}`;
	}
	// Its own checks pass; what stops it is work that has already landed.
	if (standingFailures.length > 0 && report.tests.failed.length === standingFailures.reduce((count, failure) => count + failure.tests.length, 0)) {
		return describeStandingFailure(standingFailures);
	}
	const test = report.tests.failed[0];
	return test === undefined ? "Did not pass the gate" : `Acceptance check failed on the new trunk: "${test.name}": ${test.error}`;
}
