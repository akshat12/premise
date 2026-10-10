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
import { describeFailure, type GateDeps, gateOne } from "./gate";
import { type Invalidate, invalidate } from "./invalidate";
import { type StandingFailure, standingOf, type StandingStore } from "./standing";

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
}

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
	const standing = (await deps.standing?.all()) ?? [];
	const { report, changedSymbols, newTrunkFiles, conflicts, trunkBefore, standingFailures, retired } = await gateOne(deps.gate, intent, path, { standing });
	await publish(env, { t: "gate.result", report });

	if (report.landedCommit === null || newTrunkFiles === undefined) {
		return { kind: "failed", report, note: describeFailure(report, conflicts, standingFailures), trunkAt: trunkBefore, standingFailures };
	}
	const commit = report.landedCommit;
	if (deps.cache !== undefined) {
		rememberSnapshot(deps.cache, commit, newTrunkFiles);
	}
	await settle(intentStub(env, intent.id), { a: "land", commit });
	if (deps.standing !== undefined) {
		// From now on this Intent's acceptance checks are trunk's to keep.
		const left = standingOf(intent);
		if (left.tests.length + left.assertions.length > 0) {
			await deps.standing.add(left);
		}
		// What it made untrue, having kept the dependent work passing, is no longer relied on.
		for (const intentId of new Set(retired.map((item) => item.intentId))) {
			await deps.standing.retire(intentId, retired.filter((item) => item.intentId === intentId).map((item) => item.assertionId));
		}
	}
	let stale: IntentId[] = [];
	// An Intent whose work was already on trunk lands without moving it, so there is nothing to announce.
	if (commit !== trunkBefore) {
		// Our own code is what pushed, so it reports the push; the platform's event is only relayed (see events/consumer.ts).
		await publish(env, { t: "artifacts", type: "pushed", repo: deps.gate.trunk ?? "trunk", detail: { commit, intent: intent.id } });
		await publish(env, { t: "trunk.advanced", commit, byIntent: intent.id, changedSymbols });
		stale = (await (deps.invalidate ?? invalidate)(env, { commit, byIntent: intent.id, changedSymbols, newTrunkFiles })).stale;
	}
	await publishMetrics(env);
	return { kind: "landed", commit, changedSymbols, report, stale };
}

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

	const outcome = await landWork(env, intent, path, deps);
	if (outcome.kind === "landed" || path === "rederive") {
		return outcome;
	}
	// It does not fit the trunk it would land on. That is not the end: it is stale, and gets re-derived.
	await settle(api, { a: "stale" }, outcome.note);
	await publishMetrics(env);
	return { ...outcome, kind: "stale" };
}
