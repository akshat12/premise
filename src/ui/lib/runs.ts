// The Results tab's list of live runs: each run as a row of words and numbers. Pure.
import type { RecentRuns, RunSummary } from "../../shared/runs";

/** "3:12" for a run that took three minutes and twelve seconds. */
export function took(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long ago, in the words a person would use. `now` and `at` are on the same clock. */
export function when(at: number, now: number): string {
	const ago = Math.max(0, now - at);
	if (ago < MIN) {
		return "just now";
	}
	if (ago < HOUR) {
		return `${Math.floor(ago / MIN)} min ago`;
	}
	if (ago < DAY) {
		const hours = Math.floor(ago / HOUR);
		return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	}
	const days = Math.floor(ago / DAY);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

export interface RunRow {
	key: string;
	/** The run on the board now. */
	current: boolean;
	when: string;
	by: string;
	took: string;
	agents: string;
	workload: string;
	premisesBroken: number;
	rederived: string;
	problems: number;
	/** Said beside the time when the row is not simply a finished run. */
	note: string | null;
	/** Every agent landed and nothing broken reached trunk. Only said of a run that finished. */
	clean: boolean;
}

const of = (part: number, whole: number) => (whole === 0 ? "none" : `${part} of ${whole}`);

/** A finished run in which every agent landed and nothing broken reached trunk. */
export const isClean = (run: RunSummary): boolean => run.complete && run.problems === 0 && run.agents.landed === run.agents.total;

function row(run: RunSummary, current: boolean, now: number): RunRow {
	return {
		key: current ? "current" : String(run.id),
		current,
		when: when(run.startedAt, now),
		by: run.origin === "visitor" ? "a visitor" : "the owner",
		took: took(run.endedAt - run.startedAt),
		agents: of(run.agents.landed, run.agents.total),
		workload: of(run.workload.landed, run.workload.total),
		premisesBroken: run.premisesBroken,
		rederived: of(run.rederives.succeeded, run.rederives.started),
		problems: run.problems,
		note: current ? (run.complete ? "on the board now" : "running now") : run.complete ? null : "cleared before it finished",
		clean: isClean(run),
	};
}

/** The run on the board first, then the ones before it, newest first. */
export function runRows(runs: RecentRuns, now: number): RunRow[] {
	return [...(runs.current === null ? [] : [row(runs.current, true, now)]), ...runs.past.map((run) => row(run, false, now))];
}

/**
 * The panel's one sentence, counted from the runs that finished. It says what happened, good or
 * bad: a run that let something through, or was cleared half way, is in the count.
 */
export function runsHeadline(runs: RecentRuns): string {
	const finished = [...(runs.current?.complete ? [runs.current] : []), ...runs.past.filter((run) => run.complete)];
	if (finished.length === 0) {
		return runs.current !== null ? "A run is on the board now." : "No live runs yet.";
	}
	const clean = finished.filter(isClean).length;
	if (finished.length === 1) {
		return clean === 1 ? "The last live run landed every agent, with nothing broken on trunk." : "The last live run did not land every agent cleanly.";
	}
	return clean === finished.length
		? `The last ${finished.length} live runs each landed every agent, with nothing broken on trunk.`
		: `${clean} of the last ${finished.length} live runs landed every agent with nothing broken on trunk.`;
}
