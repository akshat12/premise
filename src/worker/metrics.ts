// The numbers the UI's counters show. They are derived in one place from the event log and the
// Intent registry, so every surface agrees.
import type { PremiseEventBody } from "../shared/events";
import type { IntentKind, IntentStatus, Metrics } from "../shared/types";
import { IN_FLIGHT } from "./intent/machine";

/** Counters that only ever grow, updated as events are published. */
export type Counters = Pick<Metrics, "brokenBuildsOnTrunk" | "behaviouralRegressionsOnTrunk" | "humanMerges" | "premisesBroken" | "rederives" | "forksCreated" | "pushes">;

export function emptyCounters(): Counters {
	return { brokenBuildsOnTrunk: 0, behaviouralRegressionsOnTrunk: 0, humanMerges: 0, premisesBroken: 0, rederives: { started: 0, succeeded: 0, failed: 0 }, forksCreated: 0, pushes: 0 };
}

/** What one event adds to the counters. Pure. */
export function countEvent(counters: Counters, event: PremiseEventBody): Counters {
	switch (event.t) {
		case "premise.broken":
			return { ...counters, premisesBroken: counters.premisesBroken + 1 };
		case "artifacts":
			if (event.type === "forked") {
				return { ...counters, forksCreated: counters.forksCreated + 1 };
			}
			return event.type === "pushed" ? { ...counters, pushes: counters.pushes + 1 } : counters;
		case "rederive.race": {
			const { rederives } = counters;
			if (event.rebase === "pending" && event.rederive === "pending") {
				return { ...counters, rederives: { ...rederives, started: rederives.started + 1 } };
			}
			if (event.winner !== undefined) {
				return { ...counters, rederives: { ...rederives, succeeded: rederives.succeeded + 1 } };
			}
			return event.rebase === "fail" && event.rederive === "fail" ? { ...counters, rederives: { ...rederives, failed: rederives.failed + 1 } } : counters;
		}
		case "human.needed":
			// A person had to step in. The A/B harness counts these as human merge resolutions.
			return { ...counters, humanMerges: counters.humanMerges + 1 };
		default:
			return counters;
	}
}

export interface RegistryRow {
	id: string;
	kind: IntentKind;
	taskId: string;
	status: IntentStatus;
	updatedAt: number;
}

/** The full metrics: the counters, plus what the registry says about Intents right now. */
export function computeMetrics(counters: Counters, registry: readonly Pick<RegistryRow, "kind" | "status">[]): Metrics {
	return {
		...counters,
		agentsActive: registry.filter((row) => IN_FLIGHT.includes(row.status)).length,
		intentsLanded: registry.filter((row) => row.status === "landed").length,
	};
}
