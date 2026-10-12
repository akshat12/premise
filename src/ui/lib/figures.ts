// The run in five numbers, counted from the event log as it stands. Pure.
import type { PremiseEvent } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import type { IntentView } from "./reduce";

export interface RunFigureValues {
	agents: number;
	/** Scripted workload Intents: real forks and pushes, no model. */
	workload: number;
	premisesBroken: number;
	/** Stopped work that its agent did again, and that landed. */
	rederived: number;
	/** Stopped work that landed on a plain rebase, with nothing redone. */
	rebased: number;
	/** Times a person was asked because re-derives had failed. (Two Intents wanting one symbol is a different question, and is not counted here.) */
	asked: number;
	landed: number;
	/** Behavioural regressions and broken builds on trunk. Measured on the server, so this one comes from the log's last metrics. */
	problems: number;
}

/**
 * Everything but `problems` is counted from the events themselves, not from the periodic metrics
 * events, which trail them by a second or two: a step that says two agents were stopped must not
 * sit over a counter that still says none.
 */
export function figuresFor(events: readonly PremiseEvent[], intents: Readonly<Record<string, Pick<IntentView, "kind" | "status">>>, metrics: Pick<Metrics, "behaviouralRegressionsOnTrunk" | "brokenBuildsOnTrunk">): RunFigureValues {
	const all = Object.values(intents);
	let premisesBroken = 0;
	let rederived = 0;
	let rebased = 0;
	let asked = 0;
	for (const event of events) {
		if (event.t === "premise.broken") {
			premisesBroken++;
		} else if (event.t === "rederive.race" && event.winner === "rederive") {
			rederived++;
		} else if (event.t === "rederive.race" && event.winner === "rebase") {
			rebased++;
		} else if (event.t === "human.needed" && event.kind === "fallback") {
			asked++;
		}
	}
	return {
		agents: all.filter((intent) => intent.kind === "agent").length,
		workload: all.filter((intent) => intent.kind === "workload").length,
		premisesBroken,
		rederived,
		rebased,
		asked,
		landed: all.filter((intent) => intent.status === "landed").length,
		problems: metrics.behaviouralRegressionsOnTrunk + metrics.brokenBuildsOnTrunk,
	};
}
