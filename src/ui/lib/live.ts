// What the Live tab says about the run on the board, and what its Start button offers. Pure: the
// sentence comes from the same log the tape is drawn from, and the button from the Worker's answer.
import type { PremiseEvent } from "../../shared/events";
import type { IntentStatus } from "../../shared/types";
import { countWord, type Story, type StoryStep } from "./story";

/** The body of GET /api/live (worker/live/public-run.ts). */
export interface LiveStatus {
	enabled: boolean;
	running: boolean;
	starting: boolean;
	canStart: boolean;
	reason: "off" | "model" | "running" | "cooldown" | "cap" | null;
	nextAt: number | null;
	lastStartAt: number | null;
	startsToday: number;
	dailyCap: number;
	workload: number;
	/** The last start failed, and nothing has started since. */
	failed: boolean;
	/** The Worker's clock when it answered. Times above are on that clock. */
	now: number;
}

const AT_REST: readonly IntentStatus[] = ["landed", "failed", "escalated", "quarantined"];

/** True when there are Intents on the board and none of them is going to move by itself. */
export function runOver(intents: Readonly<Record<string, { status: IntentStatus }>>): boolean {
	const all = Object.values(intents);
	return all.length > 0 && all.every((intent) => AT_REST.includes(intent.status));
}

/** How long the log must have been silent, with every Intent at rest, before the run is summed up. */
export const SETTLE_MS = 1500;

/**
 * True when the run on the board is over and its last events are in. The last Intent to land is
 * followed, within a second, by the events that say how it got there and by the final numbers; a
 * summary written before those arrive would be wrong for that second ("Agent 4 did not land").
 * `now` is on the same clock as the events' timestamps.
 */
export function runSettled(events: readonly PremiseEvent[], intents: Readonly<Record<string, { status: IntentStatus }>>, now: number): boolean {
	const last = events.at(-1);
	return last !== undefined && runOver(intents) && now - last.ts >= SETTLE_MS;
}

export interface LiveCaption {
	/** Changes when the sentence does, so it can fade in afresh. */
	id: string;
	title: string;
	body: string;
	/** The story step the sentence is, when it is one: the rows it is about are lit on the tape. */
	step?: StoryStep;
}

export interface LiveMoment {
	/** There is no Worker behind this page (a build served as plain files), or it cannot be reached. */
	unreachable?: boolean;
	/** The stream from the Worker is not open yet, and nothing has arrived: what is on the board is not known. */
	connecting?: boolean;
	/** A run has been asked for and its Intents are not on the board yet. */
	starting: boolean;
	/** The run on the board is over and its last events are in (see runSettled). */
	over: boolean;
	/** Where the repos are: "artifacts" on Cloudflare, "memory" in a local build. Unknown until the Worker has said. */
	store: string | null;
	/** How many scripted workload Intents a run adds. */
	workload: number;
}

const where = (store: string | null) => (store === "memory" ? "in-memory repos (this is a local build, with no Cloudflare account)" : "real Cloudflare Artifacts");

/**
 * The one sentence over the live tape. While a run is going it is the latest thing the story has
 * to say; the story's last step, which sums the run up, is only said once the run is over.
 */
export function liveCaption(events: readonly PremiseEvent[], story: Story, moment: LiveMoment): LiveCaption {
	if (moment.starting) {
		return {
			id: "starting",
			title: "Starting a run.",
			body: `The board is cleared and a fresh copy of trunk is made on ${where(moment.store)}. The agents appear in a few seconds.`,
		};
	}
	const agents = events.filter((event) => event.t === "intent.created" && event.intent.kind === "agent").length;
	if (agents === 0 && moment.unreachable) {
		return {
			id: "unreachable",
			title: "The live board is not available from here.",
			body: "It is the deployed Worker's own board, and this page cannot reach a Worker. The Demo tab plays a run that was recorded on real Cloudflare Artifacts.",
		};
	}
	if (agents === 0 && moment.connecting) {
		// Said instead of "nothing is running": until the board has been read, that is not known.
		return {
			id: "connecting",
			title: "Opening the live board.",
			body: `This tab follows the deployed Worker as it happens. It is asking what is on the board right now.`,
		};
	}
	if (agents === 0) {
		return {
			id: "idle",
			title: "Nothing is running. Start a run and watch it happen.",
			body: `Twelve agents and ${moment.workload} scripted workload Intents, on ${where(moment.store)}. The agents replay prepared edits; every fork, push, typecheck, test and landing happens now.`,
		};
	}
	const told = story.steps.some((step) => step.id === "stopped");
	if (told) {
		const end = story.steps.find((step) => step.id === "end");
		if (moment.over && end !== undefined) {
			// A live run does not wait on each step as the replay does: the sentence about work that passed every
			// test and was still wrong can be on screen for a moment only. It is the point, so the summary repeats it.
			const caught = story.steps.filter((step) => step.checks !== undefined || step.id === "redone-premise").flatMap((step) => step.focus.map((id) => story.names[id] ?? id));
			const point =
				caught.length === 0
					? ""
					: caught.length === 1
						? ` ${caught[0]}'s tests all passed on the new code. Only its premise caught the problem.`
						: ` ${countWord(caught.length)} agents' tests all passed on the new code. Only their premises caught the problem.`;
			// "Did not land" reads like a fault. When every one of them gave up waiting for a claim, say that it was that.
			const gaveUp = events.flatMap((event) => (event.t === "intent.status" && event.status === "failed" ? [event.note ?? ""] : []));
			const waited = gaveUp.length > 0 && gaveUp.every((note) => /still holds/.test(note));
			const why = waited ? ` ${gaveUp.length === 1 ? "It" : "Each"} wanted a function another Intent was changing, and gave up waiting.` : "";
			return { id: "end", title: end.title, body: `${end.body}${why}${point}`, step: end };
		}
		const latest = story.steps.filter((step) => step.id !== "end").at(-1);
		if (latest !== undefined) {
			return { id: latest.id, title: latest.title, body: latest.body, step: latest };
		}
	}
	if (moment.over) {
		const landed = new Set(events.flatMap((event) => (event.t === "intent.status" && event.status === "landed" ? [event.id] : []))).size;
		return { id: "over", title: "The run is over.", body: `${landed} ${landed === 1 ? "Intent" : "Intents"} landed. No landing broke another agent's premise in this run.` };
	}
	// Before any landing has broken a premise, the story's first two steps, in the same words.
	const working = new Set(events.flatMap((event) => (event.t === "intent.status" && event.status === "working" ? [event.id] : []))).size;
	if (working < agents) {
		// No number here: the agents arrive over a few seconds, and a sentence that counts them up as they do is hard to read.
		return {
			id: "start",
			title: "The agents start work on the same code at the same time.",
			body: `Each works in its own copy, a fork on ${moment.store === "memory" ? "an in-memory repo" : "Cloudflare Artifacts"}. Premise calls each agent's task an Intent.`,
		};
	}
	return {
		id: "premises",
		title: "Premise records what each one relies on.",
		body: "Whatever an agent reads or calls goes on its list. It can also state a behaviour it depends on, as a check that can be run. Those are its premises.",
	};
}

/** "2:05" for 125 seconds, "0:09" for nine. */
export function countdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface StartOffer {
	/** The button can be pressed. */
	ready: boolean;
	/** What the button says. */
	label: string;
	/** A line beside it, when the button alone does not explain itself. */
	note: string;
}

/**
 * What the Start button says. `status` is null until the Worker has answered, and `unreachable`
 * when it could not be asked at all (a build served as plain files has no Worker behind it).
 * `now` is on the Worker's clock.
 */
export function startOffer(status: LiveStatus | null, now: number, state: { asking: boolean; unreachable: boolean }): StartOffer {
	if (state.asking) {
		return { ready: false, label: "Starting…", note: "" };
	}
	if (status === null) {
		return state.unreachable ? { ready: false, label: "Start a run", note: "The live board needs the Worker, and it cannot be reached from here. The Demo tab plays a recorded run." } : { ready: false, label: "Start a run", note: "" };
	}
	const wait = status.nextAt === null ? 0 : status.nextAt - now;
	const failed = status.failed ? "The last run could not start. " : "";
	// Readiness is the Worker's word and nothing else. The reason only chooses what to say when it is no.
	if (status.canStart) {
		return { ready: true, label: status.lastStartAt === null ? "Start a run" : "Start a new run", note: failed ? `${failed}Try again.` : "Anyone can start one. It takes three to four minutes." };
	}
	switch (status.reason) {
		case "off":
			return { ready: false, label: "Start a run", note: "Live runs are switched off at the moment. The Demo tab plays a recorded one." };
		case "model":
			return { ready: false, label: "Start a run", note: "The agents are set to a live model at the moment, so runs can only be started by the owner." };
		case "running":
			return { ready: false, label: status.starting ? "Starting…" : "Running…", note: status.starting ? "" : "A run is in progress. The next one can start when it is over." };
		case "cooldown":
			return { ready: false, label: `Next run in ${countdown(wait)}`, note: `${failed}There is a short wait between runs.` };
		case "cap":
			return { ready: false, label: "Start a run", note: `Today's ${status.dailyCap} runs have been used. The next can start in ${wait >= 3_600_000 ? `about ${Math.round(wait / 3_600_000)} ${Math.round(wait / 3_600_000) === 1 ? "hour" : "hours"}` : `${Math.max(1, Math.ceil(wait / 60_000))} ${Math.ceil(wait / 60_000) <= 1 ? "minute" : "minutes"}`}.` };
		default:
			// A reason this build of the page does not know (the Worker is newer). The button stays off and says so plainly.
			return { ready: false, label: "Start a run", note: "A run cannot be started at the moment." };
	}
}
