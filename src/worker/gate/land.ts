// Taking one Intent through the gate and dealing with the result. The Landing Durable Object
// (landing.ts) is the queue around these functions; the re-derive race (rederive.ts) uses them too.
import type { CommitSha, GateReport, Intent, IntentId, SymbolId } from "../../shared/types";
import { publish, publishMetrics } from "../hub/publish";
import { type IntentApi, intentStub } from "../intent/client";
import { IllegalTransition, type IntentAction } from "../intent/machine";
import { type FileMap, isCommitSha, type RepoStore } from "../ports/repo-store";
import { runInIsolate } from "../runner";
import { analyze, surface, type SurfaceMap } from "../surface";
import type { QueuePath } from "./client";
import { mapLimit } from "../ports/git-tree";
import { describeFailure, gateBatch, type GateDeps, gateOne, sameAsStopped } from "./gate";
import { type Invalidate, invalidate } from "./invalidate";
import { persist, type PersistOptions, persistOr } from "./persist";
import { type StandingFailure, standingOf, type StandingStore } from "./standing";
import { referenceChecks } from "./suite";

const SNAPSHOTS_KEPT = 8;

/**
 * What the gate remembers between Intents so it does not repeat work. A commit's files never
 * change, and the files trunk has after one landing are the files the next Intent rebases onto,
 * so most Intents cost one compiler run instead of three.
 */
export interface GateCache {
	snapshots: Map<CommitSha, FileMap>;
	surfaces: WeakMap<FileMap, SurfaceMap>;
}

export function newGateCache(): GateCache {
	return { snapshots: new Map(), surfaces: new WeakMap() };
}

export function rememberSnapshot(cache: GateCache, commit: CommitSha, files: FileMap): void {
	cache.snapshots.delete(commit);
	cache.snapshots.set(commit, files);
	for (const oldest of cache.snapshots.keys()) {
		if (cache.snapshots.size <= SNAPSHOTS_KEPT) {
			break;
		}
		cache.snapshots.delete(oldest);
	}
}

/** The real gate dependencies: the repo store, the TypeScript compiler, and the isolate runner. */
export function gateDeps(env: Pick<Env, "LOADER">, store: RepoStore, trunk: string, cache: GateCache = newGateCache()): GateDeps {
	return {
		trunk,
		head: (repo) => store.head(repo),
		async snapshot(repo, ref) {
			const kept = cache.snapshots.get(ref);
			if (kept !== undefined) {
				return kept;
			}
			const files = await store.snapshot(repo, ref);
			if (isCommitSha(ref)) {
				rememberSnapshot(cache, ref, files);
			}
			return files;
		},
		commitTrunk: (expectedHead, changes, message) => store.commit(trunk, expectedHead, changes, message),
		async delta(repo, from, to) {
			const paths = await store.changedPaths(repo, from, to);
			const contents = await Promise.all(paths.map((path) => store.readFile(repo, to, path)));
			return Object.fromEntries(paths.map((path, index) => [path, contents[index] ?? null]));
		},
		typecheck(files) {
			// One compiler program gives both answers; keep the surface for the diff that follows a landing.
			const result = analyze(files);
			cache.surfaces.set(files, result.surface);
			return result.typecheck;
		},
		surface(files) {
			let map = cache.surfaces.get(files);
			if (map === undefined) {
				map = surface(files).map;
				cache.surfaces.set(files, map);
			}
			return { map };
		},
		run: (req) => runInIsolate(env, req),
	};
}

export interface LandDeps {
	gate: GateDeps;
	invalidate?: Invalidate;
	cache?: GateCache;
	/** The checks landed Intents left behind. Without it, landed work is not protected (see standing.ts). */
	standing?: StandingStore;
	/**
	 * The A/B comparison's landing rule, "how teams work today": a clean textual rebase that
	 * typechecks lands. No tests, no assertions, no standing checks, no invalidation. A text
	 * conflict would need a person, so it is counted as a human merge.
	 */
	baseline?: boolean;
	/**
	 * The A/B comparison's other landing rule, a queue that runs tests: rebase, typecheck, the
	 * change's own tests, its reference checks and trunk's suite. Still no ledger, no premises, no
	 * standing checks, no invalidation and no re-derive: what does not pass goes back to its author.
	 */
	queue?: boolean;
}

/** True for either comparison rule: nothing of Premise's own (standing checks, invalidation, re-derive) applies. */
const plain = (deps: Pick<LandDeps, "baseline" | "queue">): boolean => deps.baseline === true || deps.queue === true;

export type LandOutcome =
	/** It is on trunk. `stale` lists the other Intents this landing turned stale. */
	| { kind: "landed"; commit: CommitSha; changedSymbols: SymbolId[]; report: GateReport; stale: IntentId[] }
	/** It did not get through. `trunkAt` is the trunk commit it was checked against; `standingFailures` names landed Intents it would have broken. */
	| { kind: "stale" | "failed"; report: GateReport; note: string; trunkAt: CommitSha; standingFailures: StandingFailure[] }
	/** The Intent was not waiting for the gate (it went stale, failed, or does not exist), so nothing was done. */
	| { kind: "skipped"; status: Intent["status"] | null };

export type LandEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER">;

/** Changes an Intent's status, unless something else has already moved it on. Returns whether it changed. */
export async function settle(api: IntentApi, action: IntentAction, note?: string): Promise<boolean> {
	try {
		await api.act(action, note);
		return true;
	} catch (error) {
		if (!(error instanceof IllegalTransition)) {
			throw error;
		}
		return false;
	}
}

/**
 * Gates the work described by `intent` (its repo, base and head) and, if it passes, lands it:
 * status, events, invalidation of everyone else. If it does not pass, nothing about the Intent
 * is changed; the caller decides what a failure means. `kind` is "landed" or "failed".
 */
export async function landWork(env: LandEnv, intent: Intent, path: QueuePath, deps: LandDeps): Promise<Exclude<LandOutcome, { kind: "skipped" }>> {
	const standing = plain(deps) ? [] : ((await deps.standing?.all()) ?? []);
	const rule = deps.baseline ? { skipTests: true, skipAssertions: true } : deps.queue ? { skipAssertions: true } : { standing };
	const { report, changedSymbols, newTrunkFiles, conflicts, trunkBefore, standingFailures, retired } = await gateOne(deps.gate, intent, deps.baseline ? "baseline" : path, rule);
	await publish(env, { t: "gate.result", report });

	if (report.landedCommit === null || newTrunkFiles === undefined) {
		return { kind: "failed", report, note: describeFailure(report, conflicts, standingFailures), trunkAt: trunkBefore, standingFailures };
	}
	const commit = report.landedCommit;
	if (deps.cache !== undefined) {
		rememberSnapshot(deps.cache, commit, newTrunkFiles);
	}
	// From here on the work is on trunk and cannot be taken back. A caller that sees an error would run the
	// gate again, find the work already there, and announce nothing: no event, nobody told, no checks left
	// behind. So each step below is tried more than once, and one that keeps failing is logged while the
	// rest still happen.
	const after = <T>(what: string, step: () => Promise<T>, fallback: T, options?: PersistOptions): Promise<T> =>
		persistOr(step, fallback, (error) => console.error(`gate: ${intent.id} is on trunk at ${commit}, but could not ${what}`, error instanceof Error ? error.message : String(error)), options);
	await after("mark it landed", () => settle(intentStub(env, intent.id), { a: "land", commit }), false);
	if (deps.standing !== undefined && !plain(deps)) {
		const standing = deps.standing;
		// From now on this Intent's acceptance checks are trunk's to keep.
		const left = standingOf(intent, referenceChecks(intent, newTrunkFiles));
		if (left.tests.length + left.assertions.length > 0) {
			await after("keep its checks", async () => standing.add(left), undefined);
		}
		// What it made untrue, having kept the dependent work passing, is no longer relied on.
		for (const intentId of new Set(retired.map((item) => item.intentId))) {
			await after("retire what it made untrue", async () => standing.retire(intentId, retired.filter((item) => item.intentId === intentId).map((item) => item.assertionId)), undefined);
		}
	}
	let stale: IntentId[] = [];
	// An Intent whose work was already on trunk lands without moving it, so there is nothing to announce.
	if (commit !== trunkBefore) {
		// Our own code is what pushed, so it reports the push; the platform's event is only relayed (see events/consumer.ts).
		await after("report the push", () => publish(env, { t: "artifacts", type: "pushed", repo: deps.gate.trunk ?? "trunk", detail: { commit, intent: intent.id } }), undefined);
		await after("announce it", () => publish(env, { t: "trunk.advanced", commit, byIntent: intent.id, changedSymbols }), undefined);
		// The comparison runs tell nobody that what they relied on has changed. (Invalidation claims the commit on
		// its first call, so it is not run twice here: it tries its own steps again.)
		if (!plain(deps)) {
			stale = (await after("tell the Intents that relied on what changed", () => (deps.invalidate ?? invalidate)(env, { commit, byIntent: intent.id, changedSymbols, newTrunkFiles }), null, { tries: 1 }))?.stale ?? [];
		}
	}
	await publishMetrics(env).catch(() => undefined);
	return { kind: "landed", commit, changedSymbols, report, stale };
}

/**
 * The source paths a re-derive changed, when they are exactly as the stopped work had them; null
 * otherwise. The stopped work is what the Intent had pushed when a premise it had asserted broke
 * (`intent.stopped.work`). Work that was stopped for any other reason, or before anything was
 * pushed, has nothing to be compared with: doing the same again on a newer trunk is then a retry.
 */
export async function redoneTheSame(gate: Pick<GateDeps, "snapshot">, intent: Intent, headCommit: CommitSha): Promise<string[] | null> {
	const stopped = intent.stopped?.work ?? null;
	if (intent.kind !== "agent" || stopped === null || (stopped.repo === intent.repo && stopped.commit === headCommit)) {
		return null;
	}
	// Each read is tried again if it fails. If one keeps failing this throws: "could not tell" must never be
	// taken for "different work", or a failed read would let the stopped work through.
	const read = (repo: string, commit: CommitSha) => persist(() => gate.snapshot(repo, commit));
	const [base, head, previous, previousBase] = await Promise.all([read(intent.repo, intent.baseCommit), read(intent.repo, headCommit), read(stopped.repo, stopped.commit), stopped.base === undefined ? undefined : read(stopped.repo, stopped.base)]);
	return sameAsStopped(base, head, previous, previousBase);
}

/** The report of a re-derive that was turned back without being run because it repeats the stopped work. */
export const unchangedReport = (intentId: IntentId, path: QueuePath, unchanged: string[]): GateReport => ({ intentId, path, textConflict: false, typecheck: { ok: true, errors: [] }, tests: { passed: [], failed: [] }, assertions: { passed: [], failed: [] }, unchanged, ok: false, landedCommit: null, durationMs: 0 });

/**
 * Takes one queued Intent through the gate. Publishes `gate.result`, and `trunk.advanced` when
 * trunk moved.
 *   - Path "rebase" (a first attempt): it lands, or it turns `stale`, which starts a re-derive.
 *   - Path "rederive" (a re-derived attempt): it lands, or it is reported `failed` with its
 *     status left alone, because the re-derive race decides between another attempt and a person.
 */
export async function landIntent(env: LandEnv, intentId: IntentId, path: QueuePath, deps: LandDeps): Promise<LandOutcome> {
	const api = intentStub(env, intentId);
	let intent = await api.get().catch(() => null);
	if (intent === null) {
		return { kind: "skipped", status: null };
	}
	if (path === "rebase" && intent.status === "queued") {
		intent = await api.act({ a: "gate" });
	}
	// `gating` without the step above means an earlier attempt was cut short: carry on from there.
	if (intent.status !== (path === "rebase" ? "gating" : "rederiving")) {
		return { kind: "skipped", status: intent.status };
	}

	// A re-derive that is the stopped work over again is turned back before anything is run (see `sameAsStopped`).
	if (path === "rederive" && !plain(deps) && intent.headCommit !== null) {
		// No catch here: if the stopped work cannot be read, this Intent is not gated on this pass (the caller tries again).
		const unchanged = await redoneTheSame(deps.gate, intent, intent.headCommit);
		if (unchanged !== null) {
			const report = unchangedReport(intentId, path, unchanged);
			// Trunk is read before anything is published, so a failed read cannot lead to the result being published twice.
			const trunkAt = await deps.gate.head(deps.gate.trunk ?? "trunk");
			await publish(env, { t: "gate.result", report });
			return { kind: "failed", report, note: describeFailure(report), trunkAt, standingFailures: [] };
		}
	}

	const outcome = await landWork(env, intent, path, deps);
	if (outcome.kind === "landed" || path === "rederive") {
		return outcome;
	}
	if (plain(deps)) {
		// Nothing re-derives it. A text conflict is a person's afternoon; a type error or a failed test goes back to its author.
		if (outcome.report.textConflict) {
			await publish(env, { t: "human.needed", id: intentId, kind: "fallback", message: `${outcome.note}. Someone has to merge this by hand.`, options: ["Abandon"] });
		}
		await settle(api, { a: "fail" }, outcome.note);
		await publishMetrics(env);
		return outcome;
	}
	// It does not fit the trunk it would land on. That is not the end: it is stale, and gets re-derived.
	await settle(api, { a: "stale" }, outcome.note);
	await publishMetrics(env);
	return { ...outcome, kind: "stale" };
}

export interface BatchLanding {
	/** Intents that landed together, in one commit. */
	landed: IntentId[];
	commit: CommitSha | null;
	/** Other Intents this landing turned stale. */
	stale: IntentId[];
	/** Intents to gate one at a time: the batch did not pass as a whole, or these did not rebase cleanly. */
	singly: IntentId[];
	/** Intents that stay queued for the next batch. */
	deferred: IntentId[];
}

const STATUS_WRITES_AT_ONCE = 5;

/**
 * Lands several scripted workload Intents as one commit (see `gateBatch`). Each still gets its
 * own `gate.result` and status change; trunk moves once, and the `pushed` event says how many
 * Intents the commit carries, so the UI can call it a batch.
 */
export async function landBatch(env: LandEnv, intentIds: readonly IntentId[], deps: LandDeps): Promise<BatchLanding> {
	const loaded = await mapLimit(intentIds, STATUS_WRITES_AT_ONCE, async (id) => {
		const api = intentStub(env, id);
		let intent = await api.get().catch(() => null);
		if (intent?.status === "queued") {
			intent = await api.act({ a: "gate" });
		}
		return intent;
	});
	// Anything that is not waiting at the gate (it went stale or failed meanwhile) is simply dropped, as in landIntent.
	// `rederiving` is a workload Intent that went stale and is having its rebase tried again here.
	const waiting = loaded.filter((intent): intent is Intent => intent !== null && (intent.status === "gating" || (intent.status === "rederiving" && intent.kind === "workload")));
	const retried = new Set(waiting.filter((intent) => intent.status === "rederiving").map((intent) => intent.id));
	if (waiting.length === 0) {
		return { landed: [], commit: null, stale: [], singly: [], deferred: [] };
	}
	const standing = plain(deps) ? [] : ((await deps.standing?.all()) ?? []);
	const outcome = await gateBatch(deps.gate, waiting, deps.baseline ? { standing, path: "baseline", skipTests: true } : { standing });
	if (outcome.landed === null) {
		// One at a time, then, which also shows which of them is at fault. Deferred ones go along: there is no batch to wait for.
		return { landed: [], commit: null, stale: [], singly: waiting.map((intent) => intent.id).filter((id) => !outcome.deferred.includes(id)), deferred: outcome.deferred };
	}
	const { commit, trunkBefore, members, reports, changedSymbols, changedBy, newTrunkFiles } = outcome.landed;
	if (deps.cache !== undefined) {
		rememberSnapshot(deps.cache, commit, newTrunkFiles);
	}
	// As in `landWork`: the batch is on trunk, so no step below may stop the rest. Each is tried again, and
	// logged if it still fails.
	const after = <T>(what: string, step: () => Promise<T>, fallback: T, options?: PersistOptions): Promise<T> =>
		persistOr(step, fallback, (error) => console.error(`gate: a batch is on trunk at ${commit}, but could not ${what}`, error instanceof Error ? error.message : String(error)), options);
	await mapLimit(reports, STATUS_WRITES_AT_ONCE, async (report) => {
		await after(`publish the result of ${report.intentId}`, () => publish(env, { t: "gate.result", report }), undefined);
		await after(`mark ${report.intentId} landed`, () => settle(intentStub(env, report.intentId), { a: "land", commit }), false);
		if (retried.has(report.intentId)) {
			await after(`close the race of ${report.intentId}`, () => publish(env, { t: "rederive.race", id: report.intentId, rebase: "pass", rederive: "pending", winner: "rebase" }), undefined);
		}
	});
	let stale: IntentId[] = [];
	if (commit !== trunkBefore) {
		// The event names one Intent; for a batch that is the first member that changed a type surface, or simply the first.
		const byIntent = Object.values(changedBy)[0] ?? (members[0] as IntentId);
		await after("report the push", () => publish(env, { t: "artifacts", type: "pushed", repo: deps.gate.trunk ?? "trunk", detail: { commit, intent: byIntent, intents: members, batch: members.length } }), undefined);
		await after("announce it", () => publish(env, { t: "trunk.advanced", commit, byIntent, changedSymbols }), undefined);
		if (!plain(deps)) {
			stale = ((await after("tell the Intents that relied on what changed", () => (deps.invalidate ?? invalidate)(env, { commit, byIntent, changedSymbols, newTrunkFiles, changedBy }), null, { tries: 1 }))?.stale ?? []).filter((id) => !members.includes(id));
		}
	}
	await publishMetrics(env).catch(() => undefined);
	return { landed: members, commit, stale, singly: outcome.conflicted, deferred: outcome.deferred };
}
