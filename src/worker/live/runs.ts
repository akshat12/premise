// The record of past runs: when the board is cleared, the run that was on it is kept as one line
// (see shared/runs.ts). Pure, so what goes into a line is tested without Cloudflare.
import type { PremiseEventBody } from "../../shared/events";
import type { RunSummary } from "../../shared/runs";
import type { Counters, RegistryRow } from "../metrics";
import { AT_REST } from "./public-run";

/** How many past runs are kept. Older ones are dropped. */
export const RUNS_KEPT = 30;
/** A run with more events than this is kept as a line only: its log is too big to keep thirty of. */
export const RUN_EVENTS_KEPT = 6000;

export interface RunFacts {
	id: number;
	origin: RunSummary["origin"];
	registry: readonly Pick<RegistryRow, "kind" | "status">[];
	counters: Counters;
	/** The times of the first and last events in the log. */
	firstTs: number;
	lastTs: number;
	scripted: boolean;
	/** The repo that is trunk for this run, when that is known. */
	trunk?: string | null;
}

/** Where an Intent's work is in a kept run's trunk. */
export interface Landing {
	/** The commit that landed it. */
	commit: string;
	/** Trunk before that commit. The same as `commit` when its work was already on trunk and landing moved nothing. */
	parent: string;
	/** How many Intents that commit landed. An agent's Intent lands alone; scripted workload Intents land several to a commit. */
	together: number;
}

/**
 * Finds the landing of `intentId` in a run's log. The gate's result for the Intent names the commit
 * it landed at, and is published before trunk is announced to have moved there. Landings are one
 * after another on trunk, so the commit before a landing is the one trunk was announced at before
 * it; before the first, it is the commit the first Intents were forked from. null if the Intent
 * did not land in this run, or the log does not say where trunk was. Pure.
 */
export function landingOf(events: readonly PremiseEventBody[], intentId: string): Landing | null {
	let before: string | null = null;
	let commit: string | null = null;
	// The Intents the gate has said landed at each commit not yet announced: the ones that commit carries.
	const carried = new Map<string, Set<string>>();
	for (const event of events) {
		if (event.t === "gate.result" && event.report.landedCommit !== null && event.report.landedCommit !== before) {
			carried.set(event.report.landedCommit, (carried.get(event.report.landedCommit) ?? new Set()).add(event.report.intentId));
		}
		if (event.t === "intent.created") {
			before ??= event.intent.baseCommit;
		} else if (event.t === "gate.result" && event.report.intentId === intentId && event.report.landedCommit !== null) {
			commit = event.report.landedCommit;
			if (commit === before) {
				// Its work was already on trunk: it landed without a commit of its own.
				return { commit, parent: commit, together: 1 };
			}
		} else if (event.t === "trunk.advanced") {
			if (commit !== null && event.commit === commit) {
				return before === null ? null : { commit, parent: before, together: Math.max(1, carried.get(commit)?.size ?? 1) };
			}
			before = event.commit;
		}
	}
	return null;
}

/** One run as a line, or null when there is nothing worth a line: a board with no agents on it. */
export function summariseRun(facts: RunFacts): RunSummary | null {
	const agents = facts.registry.filter((row) => row.kind === "agent");
	if (agents.length === 0) {
		return null;
	}
	const workload = facts.registry.filter((row) => row.kind === "workload");
	const landed = (rows: readonly Pick<RegistryRow, "status">[]) => rows.filter((row) => row.status === "landed").length;
	return {
		id: facts.id,
		origin: facts.origin,
		startedAt: facts.firstTs,
		endedAt: Math.max(facts.firstTs, facts.lastTs),
		complete: facts.registry.every((row) => AT_REST.includes(row.status)),
		agents: { total: agents.length, landed: landed(agents) },
		workload: { total: workload.length, landed: landed(workload) },
		premisesBroken: facts.counters.premisesBroken,
		rederives: { ...facts.counters.rederives },
		problems: facts.counters.behaviouralRegressionsOnTrunk + facts.counters.brokenBuildsOnTrunk,
		people: facts.counters.humanMerges,
		scripted: facts.scripted,
		...(facts.trunk ? { trunk: facts.trunk } : {}),
	};
}
