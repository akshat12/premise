// The record of past runs: when the board is cleared, the run that was on it is kept as one line
// (see shared/runs.ts). Pure, so what goes into a line is tested without Cloudflare.
import type { RunSummary } from "../../shared/runs";
import type { Counters, RegistryRow } from "../metrics";
import { AT_REST } from "./public-run";

/** How many past runs are kept. Older ones are dropped. */
export const RUNS_KEPT = 30;

export interface RunFacts {
	id: number;
	origin: RunSummary["origin"];
	registry: readonly Pick<RegistryRow, "kind" | "status">[];
	counters: Counters;
	/** The times of the first and last events in the log. */
	firstTs: number;
	lastTs: number;
	scripted: boolean;
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
	};
}
