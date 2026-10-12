// Runs scripted workload Intents: clearly labelled (`kind: "workload"`), no model involved, but
// every step is the real one. Each gets a real fork, real claims in the ledger, real premises, a
// real push, the post-push checker and the gate, exactly as an agent's work does.
import { newIntentId } from "../../shared/ids";
import type { Claim, Intent, IntentId, SymbolId } from "../../shared/types";
import { workflowInstanceId } from "../agent/instance";
import { type Enqueue, runChecker } from "../gate/checker";
import { gateEnqueue } from "../gate/client";
import { straightToGate } from "../agent/handoff";
import { currentMode, currentTrunk, publish, publishMetrics } from "../hub/publish";
import { intentStub, newIntent } from "../intent/client";
import { requestClaimsAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import { mapLimit } from "../ports/git-tree";
import type { FileMap, RepoStore } from "../ports/repo-store";
import { analyze } from "../surface";
import { indexRepo } from "../symbols";
import { TokenBucket } from "./bucket";
import { applyEdit, editPaths, type EditSpec, generateEdits } from "./generate";
import { release } from "../ports/release";

export const WORKLOAD_TASK = "workload";
/** Ledger priority. Higher number than any agent's, so an agent always wins a contested symbol. */
export const WORKLOAD_PRIORITY = 50;
export const CLAIM_RETRIES = 3;
/** Roughly how many Artifacts requests one workload Intent makes before it reaches the gate. */
export const CALLS_PER_INTENT = 12;
export const ARTIFACTS_CALLS_PER_SECOND = 150;
export const MAX_WORKLOAD = 1000;

/** One workload Intent, as plain data: everything needed to run it somewhere else. */
export interface WorkloadJob {
	intentId: IntentId;
	label: string;
	spec: EditSpec;
	claims: Claim[];
	/** What it relies on, with each symbol's type surface as trunk had it when the run was planned. */
	reads: { symbol: SymbolId; surfaceHash: string }[];
}

export interface WorkloadResult {
	id: IntentId;
	/** Where it had got to when its own part ended: `queued` if it reached the gate, else `failed` (or wherever the checker left it). */
	status: Intent["status"];
	error?: string;
}

type WorkloadEnv = Parameters<typeof runChecker>[0] & Pick<Env, "LANDING">;

export interface RunOneOptions {
	trunk: string;
	/** Where a checked Intent goes. Defaults to the gate. */
	enqueue?: Enqueue;
	/** First pause before asking the ledger again; it doubles each time. */
	backoffMs?: number;
}

/**
 * Takes one workload Intent from nothing to the gate's queue. Never throws: anything that goes
 * wrong fails the Intent, which releases whatever it held. Workload Intents never ask a person.
 */
export async function runWorkloadIntent(env: WorkloadEnv, store: RepoStore, job: WorkloadJob, options: RunOneOptions): Promise<WorkloadResult> {
	const id = job.intentId;
	const api = intentStub(env, id);
	try {
		const { head } = await store.fork(options.trunk, id);
		await publish(env, { t: "artifacts", type: "forked", repo: id, detail: { source: options.trunk, workload: true } });
		await api.init(newIntent({ id, kind: "workload", taskId: WORKLOAD_TASK, goal: job.label, acceptance: [], baseCommit: head }));
		await api.recordPremises(job.reads.map((read) => ({ symbol: read.symbol, source: "observed" as const, surfaceHash: read.surfaceHash, state: "holding" as const })));

		// True in either comparison run of the A/B report: no ledger, no checker.
		const baseline = (await currentMode(env)) !== "premise";
		await api.act({ a: "claim" });
		const symbols = job.claims.map((claim) => claim.symbol);
		// The comparison run has no ledger: nobody asks before editing.
		for (let attempt = 0; !baseline; attempt++) {
			const decision = await requestClaimsAcrossShards(env, { intentId: id, claims: job.claims, priority: WORKLOAD_PRIORITY, dependsOn: [] });
			await publish(env, { t: "claim.decision", id, decision, symbols });
			if (decision.kind === "granted") {
				break;
			}
			if (attempt >= CLAIM_RETRIES) {
				const holder = decision.kind === "split" ? decision.with : decision.on;
				throw new Error(`could not get ${symbols.join(", ")}: Intent ${holder} still holds it after ${CLAIM_RETRIES} retries`);
			}
			await new Promise((resolve) => setTimeout(resolve, (options.backoffMs ?? 500) * 2 ** attempt));
		}
		await api.setClaims(job.claims);
		await api.act({ a: "granted" });

		// The edit is applied to the fork's own copy of the file, which may be newer than the one the run was planned on.
		const files: FileMap = {};
		for (const path of editPaths(job.spec)) {
			const content = await store.readFile(id, head, path);
			if (content !== null) {
				files[path] = content;
			}
		}
		const commit = await store.commit(id, head, applyEdit(job.spec, files), `intent ${id}: ${job.label}`);
		await publish(env, { t: "artifacts", type: "pushed", repo: id, detail: { commit, intent: id, workload: true } });
		await api.act({ a: "submit", commit });

		const enqueue = options.enqueue ?? gateEnqueue(env);
		if (baseline) {
			await straightToGate(env, await api.get(), { enqueue });
		} else {
			await runChecker(env, id, { store, enqueue });
		}
		return { id, status: (await api.get()).status };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		// A premise can break between two of the steps above. The Intent is then stale and the gate is already
		// seeing to it (a rebase, for a workload Intent). That is not this runner's failure to report.
		const now = (await api.get().catch(() => null))?.status;
		if (now === "stale" || now === "rederiving") {
			return { id, status: now };
		}
		await api.act({ a: "fail" }, reason.slice(0, 300)).catch(() => undefined);
		return { id, status: "failed", error: reason };
	}
}

export interface WorkloadOptions {
	n: number;
	seed: number;
	/** How many run at once (in-process), or are started per second (as Workflow instances). */
	concurrency?: number;
	overlapRate?: number;
}

export interface WorkloadPlan {
	trunk: string;
	jobs: WorkloadJob[];
	/** How many edits of each kind. `overlap` counts body edits aimed at a function another edit touches. */
	kinds: { helper: number; body: number; field: number; overlap: number };
}

/** Reads trunk once, generates the edits, and turns each into a job with a fresh Intent id. */
export async function planWorkload(env: Pick<Env, "HUB" | "TRUNK_REPO">, store: RepoStore, options: WorkloadOptions): Promise<WorkloadPlan> {
	const trunk = await currentTrunk(env);
	const files = await store.snapshot(trunk, "main");
	// One compiler run for the whole workload: every job's premises take their hashes from here.
	const surfaces = analyze(files).surface;
	const edits = generateEdits(indexRepo(files), files, options.n, options.seed, options.overlapRate ?? 0.1);
	const kinds = { helper: 0, body: 0, field: 0, overlap: 0 };
	const jobs = edits.map((edit): WorkloadJob => {
		kinds[edit.spec.kind]++;
		if (edit.spec.kind === "body" && edit.spec.overlaps !== undefined) {
			kinds.overlap++;
		}
		return {
			intentId: newIntentId(),
			label: edit.label,
			spec: edit.spec,
			claims: edit.claims,
			reads: edit.reads.flatMap((symbol) => {
				const hash = surfaces.get(symbol)?.hash;
				return hash === undefined ? [] : [{ symbol, surfaceHash: hash }];
			}),
		};
	});
	return { trunk, jobs, kinds };
}

/** How the jobs of a plan get run. */
export type Spawn = (plan: WorkloadPlan) => Promise<{ started: number; results?: WorkloadResult[] }>;

const COSTS: Partial<Record<keyof RepoStore, number>> = { fork: 3, commit: 4, snapshot: 20, listFiles: 5 };

/** A RepoStore whose every call first takes its cost from the bucket. */
export function throttled(store: RepoStore, bucket: TokenBucket): RepoStore {
	return new Proxy(store, {
		get(target, property, receiver) {
			const value: unknown = Reflect.get(target, property, receiver);
			if (typeof value !== "function") {
				return value;
			}
			return async (...args: unknown[]) => {
				await bucket.take(COSTS[property as keyof RepoStore] ?? 1);
				return (value as (...inner: unknown[]) => unknown).apply(target, args);
			};
		},
	});
}

/**
 * Runs the jobs inside this invocation, `concurrency` at a time. Right for local dev and tests.
 * Metrics go out every two seconds rather than per Intent, so hundreds of Intents do not flood
 * the event stream.
 */
export function spawnInProcess(env: WorkloadEnv, store: RepoStore, options: { concurrency?: number; enqueue?: Enqueue; backoffMs?: number; bucket?: TokenBucket } = {}): Spawn {
	return async (plan) => {
		const paced = throttled(store, options.bucket ?? new TokenBucket(ARTIFACTS_CALLS_PER_SECOND));
		const ticker = setInterval(() => void publishMetrics(env).catch(() => undefined), 2000);
		try {
			const results = await mapLimit(plan.jobs, options.concurrency ?? 25, (job) => runWorkloadIntent(env, paced, job, { trunk: plan.trunk, ...(options.enqueue ? { enqueue: options.enqueue } : {}), ...(options.backoffMs === undefined ? {} : { backoffMs: options.backoffMs }) }));
			return { started: results.length, results };
		} finally {
			clearInterval(ticker);
			await publishMetrics(env).catch(() => undefined);
		}
	};
}

export interface WorkloadParams {
	mode: "workload";
	job: WorkloadJob;
	trunk: string;
}

export const isWorkloadParams = (params: unknown): params is WorkloadParams => typeof params === "object" && params !== null && (params as { mode?: unknown }).mode === "workload";

/**
 * Starts each job as its own Workflow instance, so each has its own request budget (one
 * invocation could not make the tens of thousands of requests that 300 Intents need). Instances
 * are created in batches, paced so that their Artifacts calls stay near `callsPerSecond` in total.
 * `singly` creates them one at a time instead (the local runtime: see below).
 */
export function spawnWorkflows(env: Pick<Env, "AGENT_WORKFLOW">, options: { callsPerSecond?: number; bucket?: TokenBucket; singly?: boolean } = {}): Spawn {
	return async (plan) => {
		const rate = options.callsPerSecond ?? ARTIFACTS_CALLS_PER_SECOND;
		const bucket = options.bucket ?? new TokenBucket(rate);
		const perBatch = Math.max(1, Math.min(100, Math.floor(rate / CALLS_PER_INTENT)));
		let started = 0;
		for (let from = 0; from < plan.jobs.length; from += perBatch) {
			const batch = plan.jobs.slice(from, from + perBatch);
			await bucket.take(batch.length * CALLS_PER_INTENT);
			const params = (job: WorkloadJob): WorkloadParams => ({ mode: "workload", job, trunk: plan.trunk });
			if (options.singly) {
				// The local runtime's own batch call leaves an RPC stub undisposed, and that runtime has been seen
				// to crash on it (see ports/release.ts). Locally there is no rate to keep to, so each is created alone.
				for (const job of batch) {
					release(await env.AGENT_WORKFLOW.create({ id: workflowInstanceId(job.intentId, 0), params: params(job) }));
				}
			} else {
				release(await env.AGENT_WORKFLOW.createBatch({ instances: batch.map((job) => ({ id: workflowInstanceId(job.intentId, 0), params: params(job) })) } as never));
			}
			started += batch.length;
		}
		return { started };
	};
}

export interface WorkloadSummary {
	n: number;
	seed: number;
	trunk: string;
	started: number;
	kinds: WorkloadPlan["kinds"];
	intents: IntentId[];
	/** Present when the jobs ran in-process: how each one's own part ended. */
	results?: WorkloadResult[];
	ms: number;
}

/**
 * Plans and starts a workload of `n` Intents. With no `spawn` given the jobs become Workflow
 * instances and this returns as soon as they are started; they reach the gate over the next
 * minute and land after that.
 */
export async function runWorkload(env: Env, options: WorkloadOptions, deps: { store?: RepoStore; spawn?: Spawn } = {}): Promise<WorkloadSummary> {
	if (!Number.isInteger(options.n) || options.n < 1 || options.n > MAX_WORKLOAD) {
		throw new RangeError(`n must be a whole number from 1 to ${MAX_WORKLOAD}`);
	}
	const begun = Date.now();
	const store = deps.store ?? getRepoStore(env);
	const plan = await planWorkload(env, store, options);
	// In-memory repos mean the local runtime, where instances are created one at a time (see `spawnWorkflows`).
	const spawned = await (deps.spawn ?? spawnWorkflows(env, { ...(options.concurrency === undefined ? {} : { callsPerSecond: options.concurrency * CALLS_PER_INTENT }), singly: env.REPO_STORE === "memory" }))(plan);
	await publishMetrics(env);
	return { n: options.n, seed: options.seed, trunk: plan.trunk, started: spawned.started, kinds: plan.kinds, intents: plan.jobs.map((job) => job.intentId), ...(spawned.results ? { results: spawned.results } : {}), ms: Date.now() - begun };
}
