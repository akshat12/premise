// The gate, for one Intent: rebase onto trunk, typecheck, run its acceptance tests, the task's
// reference checks, trunk's existing tests and the premise assertions, and only then commit to trunk. Everything it touches comes in through `GateDeps`, so
// the whole pipeline runs in a unit test with an in-memory repo.
import type { CommitSha, GateReport, Intent, IntentId, SymbolId } from "../../shared/types";
import { type FileChanges, type FileMap, StaleHeadError } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";
import { diffSurface, type SurfaceMap, type TypecheckResult } from "../surface";
import { threeWayRebase } from "./rebase";
import { describeStandingFailure, judgeStanding, planStanding, type Standing, type StandingFailure, standingRequest, type StandingVerdict } from "./standing";
import { referenceChecks, suiteTests, type TestRef } from "./suite";

export interface GateDeps {
	snapshot(repo: string, ref: string): Promise<FileMap>;
	head(repo: string): Promise<CommitSha>;
	commitTrunk(expectedHead: CommitSha, changes: FileChanges, message: string): Promise<CommitSha>;
	typecheck(files: FileMap): TypecheckResult;
	surface(files: FileMap): { map: SurfaceMap };
	run(req: RunRequest): Promise<RunResult>;
	/** The repo acting as trunk. Defaults to "trunk". */
	trunk?: string;
	/**
	 * Optional and only a saving: what changed in `repo` between two commits. With it, an Intent's
	 * head is built from its base plus its few changed files instead of reading the whole tree again.
	 */
	delta?(repo: string, from: CommitSha, to: CommitSha): Promise<FileChanges>;
}

/** An Intent's files at its head, the cheap way when the store can say what changed. */
async function headFiles(deps: GateDeps, intent: Intent & { headCommit: CommitSha }, base: FileMap): Promise<FileMap> {
	if (deps.delta === undefined) {
		return deps.snapshot(intent.repo, intent.headCommit);
	}
	const files = { ...base };
	for (const [path, content] of Object.entries(await deps.delta(intent.repo, intent.baseCommit, intent.headCommit))) {
		if (content === null) {
			delete files[path];
		} else {
			files[path] = content;
		}
	}
	return files;
}

export type GatePath = GateReport["path"];

export interface GateOptions {
	/** Do not run the premise assertions (the A/B baseline has none). */
	skipAssertions?: boolean;
	/** Run no tests at all: not the Intent's own, not its reference checks, not trunk's suite (the A/B baseline lands on typecheck alone). */
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

type Verdict = Pick<GateReport, "textConflict" | "typecheck" | "tests" | "assertions" | "reference" | "suite">;

/** The reference file exists to be out of the agent's reach. Work that changes it does not land. */
export const REFERENCE_TAMPERED = "this Intent changed the task's reference checks, which are trunk's to keep";

/** Splits one run's test results back into the groups they were asked for in. */
function carve<T>(results: readonly T[], sizes: readonly number[]): T[][] {
	let from = 0;
	return sizes.map((size) => results.slice(from, (from += size)));
}

const failuresOf = (results: RunResult["tests"], label: (test: TestRef) => string) => results.filter((test) => !test.ok).map((test) => ({ name: label(test), error: test.error ?? "failed" }));

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
	const [trunkFiles, base] = await Promise.all([deps.snapshot(trunk, trunkHead), deps.snapshot(intent.repo, intent.baseCommit)]);
	const head = await headFiles(deps, { ...intent, headCommit: intent.headCommit }, base);

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
	// The task's reference checks, as trunk has them. They are run only if the work left that file alone.
	const reference = opts.skipTests ? [] : referenceChecks(intent, trunkFiles);
	const referenceTampered = reference.length > 0 && merged[reference[0]?.file ?? ""] !== trunkFiles[reference[0]?.file ?? ""];
	const referenceRun = referenceTampered ? [] : reference;
	// The checks landed Intents left behind run in the same isolate as the lander's own.
	const plan = planStanding(opts.standing ?? [], intent, trunkFiles, merged);
	const extra = standingRequest(plan);
	// Every other test on trunk, as merged. One that is already being run under another heading is not run twice.
	const suite = opts.skipTests ? [] : suiteTests(merged, [...tests, ...extra.tests, ...plan.tampered]);
	const asked = [...tests, ...referenceRun, ...suite, ...extra.tests];
	const nothingToRun = asked.length + assertions.length + extra.assertions.length === 0;
	const run: RunResult = nothingToRun ? { tests: [], assertions: [] } : await deps.run({ files: merged, tests: asked, assertions: [...assertions, ...extra.assertions] });
	const [ownTests = [], referenceTests = [], suiteResults = [], standingTests = []] = carve(run.tests, [tests.length, referenceRun.length, suite.length, extra.tests.length]);
	// The report's test and assertion lists are the Intent's own; a landed check that fails is added to the failures.
	const ownRun: RunResult = { ...run, tests: ownTests, assertions: run.assertions.slice(0, assertions.length) };
	const ran = tests.length + assertions.length === 0 && run.loadError === undefined ? NOT_RUN : summarise(intent, ownRun);
	const loaded = run.loadError === undefined;
	const standing = loaded ? judgeStanding(plan, { tests: standingTests, assertions: run.assertions.slice(assertions.length) }) : judgeStanding({ ...plan, tests: [], assertions: [] }, { tests: [], assertions: [] });
	const landedFailed = standing.failures.flatMap((failure) => failure.tests.map((test) => ({ name: test.name, error: `(acceptance check of landed Intent ${failure.intentId}) ${test.error}` })));
	const verdict: Verdict = { textConflict: false, typecheck, tests: { passed: ran.tests.passed, failed: [...ran.tests.failed, ...landedFailed] }, assertions: ran.assertions };
	if (reference.length > 0) {
		verdict.reference = referenceTampered
			? { passed: [], failed: reference.map((test) => ({ name: test.name, error: REFERENCE_TAMPERED })) }
			: { passed: loaded ? referenceTests.filter((test) => test.ok).map((test) => test.name) : [], failed: failuresOf(referenceTests, (test) => test.name) };
	}
	if (suite.length > 0) {
		verdict.suite = { passed: loaded ? suiteResults.filter((test) => test.ok).length : 0, failed: failuresOf(suiteResults, (test) => `${test.file}: ${test.name}`) };
	}
	if (verdict.tests.failed.length > 0 || verdict.assertions.failed.length > 0 || (verdict.reference?.failed.length ?? 0) > 0 || (verdict.suite?.failed.length ?? 0) > 0) {
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
 * rebase is clean, the result typechecks, and every acceptance test, reference check, test already
 * on trunk and asserted premise passes.
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
	if (test !== undefined) {
		return `Acceptance check failed on the new trunk: "${test.name}": ${test.error}`;
	}
	const reference = report.reference?.failed[0];
	if (reference !== undefined) {
		return `Reference check failed on the new trunk: "${reference.name}": ${reference.error}`;
	}
	const existing = report.suite?.failed[0];
	const more = (report.suite?.failed.length ?? 0) - 1;
	return existing === undefined ? "Did not pass the gate" : `Breaks a test that is already on trunk: "${existing.name}": ${existing.error}${more > 0 ? ` (and ${more} more)` : ""}`;
}

export interface BatchOutcome {
	/** What landed, or null when the batch could not land as one (land its members one at a time instead). */
	landed: {
		commit: CommitSha;
		trunkBefore: CommitSha;
		members: IntentId[];
		reports: GateReport[];
		changedSymbols: SymbolId[];
		/** Which member changed which symbol's type surface. A symbol that changed only because it mentions another is put down to that other's member. */
		changedBy: Record<SymbolId, IntentId>;
		newTrunkFiles: FileMap;
	} | null;
	/** Members whose rebase conflicts with trunk or with an earlier member. Gate these on their own, so each gets its own verdict. */
	conflicted: IntentId[];
	/** Members left for the next batch. (Currently none are; kept so a caller need not change if a batch is ever capped.) */
	deferred: IntentId[];
	/** Why the batch could not land as one, when it could not. */
	reason?: string;
}

/** The commit message for a batch: one line saying what it is, and a trailer for every Intent in it. */
export function batchMessage(intents: readonly Pick<Intent, "id">[]): string {
	return `batch of ${intents.length} workload intent${intents.length === 1 ? "" : "s"}\n\n${intents.map((intent) => `Premise-Intent: ${intent.id}`).join("\n")}`;
}

/**
 * Lands several Intents as one commit: each is rebased in turn onto trunk plus the ones before it,
 * the result is typechecked once, the landed Intents' standing checks run once, and one commit
 * goes to trunk. Only for Intents with no acceptance checks or assertions of their own (the
 * scripted workload): an Intent with checks gets a gate run to itself.
 *
 * If the combined result does not pass, nothing lands and `landed` is null; the caller then gates
 * the members singly, which also says which of them was at fault.
 */
export async function gateBatch(deps: GateDeps, intents: readonly Intent[], opts: Pick<GateOptions, "standing" | "skipTests"> & { path?: GatePath } = {}): Promise<BatchOutcome> {
	const started = Date.now();
	const none = (reason: string): BatchOutcome => ({ landed: null, conflicted: [], deferred: [], reason });
	if (intents.some((intent) => intent.acceptance.length > 0 || intent.premises.some((premise) => premise.source === "asserted") || intent.headCommit === null)) {
		return none("a member has checks of its own");
	}
	const trunk = deps.trunk ?? DEFAULT_TRUNK;
	const trunkHead = await deps.head(trunk);
	const trunkFiles = await deps.snapshot(trunk, trunkHead);
	const before = deps.surface(trunkFiles).map;

	// Reading each member's files is the slow part, and the members do not depend on each other for it.
	const loaded = await Promise.all(
		intents.map(async (intent) => {
			const base = await deps.snapshot(intent.repo, intent.baseCommit);
			return { intent, base, head: await headFiles(deps, { ...intent, headCommit: intent.headCommit as CommitSha }, base) };
		}),
	);
	let merged = trunkFiles;
	const members: Intent[] = [];
	const conflicted: IntentId[] = [];
	const deferred: IntentId[] = [];
	for (const { intent, base, head } of loaded) {
		const rebased = threeWayRebase(base, head, merged);
		if (rebased.conflicts.length > 0) {
			conflicted.push(intent.id);
			continue;
		}
		merged = rebased.files;
		members.push(intent);
	}
	if (members.length === 0) {
		return { landed: null, conflicted, deferred, reason: "no member rebases cleanly" };
	}

	const checked = deps.typecheck(merged);
	if (!checked.ok) {
		return { ...none(`typecheck failed: ${checked.errors[0] ?? "unknown error"}`), conflicted, deferred };
	}
	const plan = planStanding(opts.standing ?? [], { id: "", acceptance: [] }, trunkFiles, merged);
	const extra = standingRequest(plan);
	// Trunk's own tests run once for the whole batch.
	const suite = opts.skipTests ? [] : suiteTests(merged, [...extra.tests, ...plan.tampered]);
	let suitePassed = 0;
	if (plan.tampered.length > 0 || suite.length + extra.tests.length + extra.assertions.length > 0) {
		const run: RunResult = plan.tampered.length > 0 ? { tests: [], assertions: [] } : await deps.run({ files: merged, tests: [...suite, ...extra.tests], assertions: extra.assertions });
		const [suiteResults = [], standingTests = []] = carve(run.tests, [suite.length, extra.tests.length]);
		const verdict = run.loadError !== undefined ? null : judgeStanding(plan, { tests: standingTests, assertions: run.assertions });
		if (verdict === null || verdict.failures.length > 0) {
			return { ...none(verdict === null ? "the merged files do not load" : describeStandingFailure(verdict.failures)), conflicted, deferred };
		}
		const broke = failuresOf(suiteResults, (test) => `${test.file}: ${test.name}`)[0];
		if (broke !== undefined) {
			return { ...none(`breaks a test that is already on trunk: "${broke.name}": ${broke.error}`), conflicted, deferred };
		}
		suitePassed = suiteResults.length;
	}

	const changes = changesBetween(trunkFiles, merged);
	const commit = Object.keys(changes).length === 0 ? trunkHead : await deps.commitTrunk(trunkHead, changes, batchMessage(members));
	const after = deps.surface(merged).map;
	const moved = diffSurface(before, after);
	const changedSymbols = [...moved.changed, ...moved.removed].sort();
	// Who changed what. A member that changes the surface of a symbol trunk already had must hold
	// an interface claim on it (the post-push checker sees to that), so the claims say whose it is.
	const changedBy: Record<SymbolId, IntentId> = {};
	for (const intent of members) {
		for (const claim of intent.claims) {
			if (claim.mode === "interface" && before.has(claim.symbol) && changedSymbols.includes(claim.symbol)) {
				changedBy[claim.symbol] ??= intent.id;
			}
		}
	}
	// A symbol that changed only because it mentions a changed one belongs to whoever changed that one.
	for (let grew = true; grew; ) {
		grew = false;
		for (const symbol of changedSymbols) {
			if (changedBy[symbol] !== undefined) {
				continue;
			}
			const via = [...(after.get(symbol)?.refs ?? []), ...(before.get(symbol)?.refs ?? [])].find((ref) => changedBy[ref] !== undefined);
			if (via !== undefined) {
				changedBy[symbol] = changedBy[via] as IntentId;
				grew = true;
			}
		}
	}
	const durationMs = Date.now() - started;
	const ranSuite = suite.length > 0 ? { suite: { passed: suitePassed, failed: [] } } : {};
	const reports = members.map((intent): GateReport => ({ intentId: intent.id, path: opts.path ?? "rebase", textConflict: false, typecheck: { ok: true, errors: [] }, ...NOT_RUN, ...ranSuite, ok: true, landedCommit: commit, durationMs }));
	return { landed: { commit, trunkBefore: trunkHead, members: members.map((intent) => intent.id), reports, changedSymbols, changedBy, newTrunkFiles: merged }, conflicted, deferred };
}
