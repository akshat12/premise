// A run of the live board in one line: what the Results tab lists under "Recent live runs".
// Shared by the Worker, which writes one when the board is cleared, and the UI, which shows them.

export interface RunSummary {
	/** Its number in the Worker's record of runs. 0 for the run that is on the board now. */
	id: number;
	/** Who started it: a visitor with the Start button, or the owner with the admin token. */
	origin: "visitor" | "owner";
	/** The first and last events of the run. */
	startedAt: number;
	endedAt: number;
	/** Every Intent had come to rest. False for a run that was still going when the board was cleared, or is going now. */
	complete: boolean;
	agents: { total: number; landed: number };
	/** Scripted workload Intents. */
	workload: { total: number; landed: number };
	premisesBroken: number;
	rederives: { started: number; succeeded: number; failed: number };
	/** Behavioural regressions and broken builds that reached trunk. */
	problems: number;
	/** Times a person had to step in. */
	people: number;
	/** The agents replayed prepared edits (true), or were a model (false). */
	scripted: boolean;
	/** How many of its events the Worker kept, so that it can be replayed. 0 or absent when only the line was kept. */
	events?: number;
}

export interface RecentRuns {
	/** The run on the board now, if there is one. */
	current: RunSummary | null;
	/** Earlier runs, newest first. Only the most recent are kept. */
	past: RunSummary[];
}
