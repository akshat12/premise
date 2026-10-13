// A run that anyone can start from the Live tab, with no token. This file is everything that
// decides whether one may start. It is pure, so the limits are tested without Cloudflare.
//
// A public run is always the same thing: a reset, the demo repo's tasks with scripted agents, and a
// small scripted workload. The caller chooses nothing. What bounds the cost is here: one run at a
// time, a wait between starts, a number a day, and a switch that turns the button off.
import type { IntentStatus } from "../../shared/types";

export const PUBLIC_RUN = {
	/** Scripted workload Intents in a public run, beside the demo repo's tasks. */
	workload: 30,
	/** Workload seeds, taken in turn, so two runs in a row are not the same run. */
	seeds: [7, 11, 23],
	/** From one start to the next. */
	cooldownMs: 3 * 60_000,
	/** How many may start in any 24 hours. */
	dailyCap: 40,
	/** A start that has been taken counts as running for this long, whether or not its Intents are on the board yet. */
	startingMs: 60_000,
	/** A reset that has begun and not finished counts as running for this long. (It deletes forks and imports trunk, which takes a while.) */
	resettingMs: 5 * 60_000,
	/** After anyone's reset the board is empty until they dispatch, a second or two later. It counts as running for this long. */
	resetGraceMs: 15_000,
	/** A run with unfinished Intents and no event for this long is taken to be stuck. It no longer holds up a start. */
	stallMs: 3 * 60_000,
	/** However talkative, a run that is still unfinished this long after its reset is taken to be stuck too. */
	maxRunMs: 15 * 60_000,
} as const;

const DAY_MS = 24 * 60 * 60_000;

/** An Intent in one of these is not going to move by itself: it landed, it gave up, or it waits for a person. */
export const AT_REST: readonly IntentStatus[] = ["landed", "failed", "escalated", "quarantined"];

/** What is kept between requests. It survives a reset. */
export interface PublicRunState {
	/** The switch. false refuses every start. An admin route sets it; no deploy is needed. */
	enabled: boolean;
	/** When each run of the last 24 hours started, oldest first. */
	starts: number[];
	/** Every start there has ever been. It picks the seed. */
	count: number;
	/** Set when a start did not get as far as dispatching its tasks: which start (`at`), why, and when that was found out. */
	failed?: { at: number; error: string; recordedAt: number };
}

export const newPublicRunState = (): PublicRunState => ({ enabled: true, starts: [], count: 0 });

/** What is true of the board at the moment of asking. */
export interface PublicRunFacts {
	now: number;
	/** The agents replay recorded turns. A public run never spends on a model. */
	scripted: boolean;
	/** Intents on the board. */
	intents: number;
	/** Those of them that are still moving (not AT_REST). */
	unsettled: number;
	/** The gate has something queued, is checking something, or has stale Intents to re-derive. */
	gateBusy: boolean;
	/** When the last event was logged. 0 if the log is empty. */
	lastEventAt: number;
	/** When the board was last reset, by anyone. 0 if never. */
	resetAt: number;
	/** When a reset that has not finished yet was begun. 0 if none is under way. */
	resetBegunAt: number;
}

/** What the hub knows about the board; the caller adds the rest. */
export type BoardFacts = Pick<PublicRunFacts, "intents" | "unsettled" | "lastEventAt" | "resetAt" | "resetBegunAt">;

/** True when the agents replay recorded turns: the provider chosen at run time if there is one, else the configured one. */
export function isScripted(chosen: { provider: string } | null, configured: string | undefined): boolean {
	return ((chosen?.provider ?? configured ?? "scripted").trim() || "scripted") === "scripted";
}

export type Refusal = "off" | "model" | "running" | "cooldown" | "cap";

export interface PublicRunStatus {
	enabled: boolean;
	/** A run is on the board, or one has just been started and has not reached it yet. */
	running: boolean;
	/** The part of `running` before the first Intents appear. */
	starting: boolean;
	canStart: boolean;
	/** Why not, when `canStart` is false. */
	reason: Refusal | null;
	/** When a start will next be allowed, if that is only a matter of time. */
	nextAt: number | null;
	lastStartAt: number | null;
	startsToday: number;
	dailyCap: number;
	/** What a run is made of, for the page to say before it starts. */
	workload: number;
	/** The last start failed, and nothing has started since. (Why is kept in the hub and in the Worker's log; this answer is public.) */
	failed: boolean;
	now: number;
}

const recent = (starts: readonly number[], now: number) => starts.filter((at) => now - at < DAY_MS);

/** A run that has gone silent, or gone on far too long, no longer counts as one in progress. */
const isStuck = (facts: PublicRunFacts) => facts.now - Math.max(facts.lastEventAt, facts.resetAt) >= PUBLIC_RUN.stallMs || (facts.resetAt > 0 && facts.now - facts.resetAt >= PUBLIC_RUN.maxRunMs);

/** Whether a run may start now, and if not, why and until when. The first reason that applies is the one given. */
export function publicRunStatus(state: PublicRunState, facts: PublicRunFacts): PublicRunStatus {
	const { now } = facts;
	const today = recent(state.starts, now);
	const lastStartAt = state.starts.at(-1) ?? null;
	// A failure is news about the last start only.
	const failure = state.failed !== undefined && (lastStartAt === null || state.failed.at >= lastStartAt) ? state.failed : null;
	// A start is first a claim, then a reset, then Intents. Until the Intents appear the board shows
	// the run before, or nothing, and neither means "over".
	const claimed = failure === null && lastStartAt !== null && now - lastStartAt < PUBLIC_RUN.startingMs && (facts.resetAt < lastStartAt || facts.intents === 0);
	// Anyone's reset counts the same way: while it is under way, and for the few seconds between its
	// end and the first Intent (an admin about to dispatch). The reset of a start that then failed
	// does not, or the button would say "starting" about a start known to be dead. A reset made
	// after that failure was found out is somebody else's, and does.
	const resetting = facts.resetBegunAt > facts.resetAt && now - facts.resetBegunAt < PUBLIC_RUN.resettingMs;
	const justReset = facts.intents === 0 && facts.resetAt > 0 && now - facts.resetAt < PUBLIC_RUN.resetGraceMs && (failure === null || facts.resetAt > failure.recordedAt);
	const starting = claimed || resetting || justReset;
	const moving = facts.unsettled > 0 || facts.gateBusy;
	const running = starting || (moving && !isStuck(facts));

	const cooldownEnds = lastStartAt === null ? 0 : lastStartAt + PUBLIC_RUN.cooldownMs;
	const capEnds = today.length >= PUBLIC_RUN.dailyCap ? (today[today.length - PUBLIC_RUN.dailyCap] as number) + DAY_MS : 0;
	let reason: Refusal | null = null;
	let nextAt: number | null = null;
	if (!state.enabled) {
		reason = "off";
	} else if (!facts.scripted) {
		reason = "model";
	} else if (running) {
		reason = "running";
	} else if (capEnds > now) {
		reason = "cap";
		nextAt = Math.max(capEnds, cooldownEnds);
	} else if (cooldownEnds > now) {
		reason = "cooldown";
		nextAt = cooldownEnds;
	}
	return { enabled: state.enabled, running, starting, canStart: reason === null, reason, nextAt, lastStartAt, startsToday: today.length, dailyCap: PUBLIC_RUN.dailyCap, workload: PUBLIC_RUN.workload, failed: failure !== null, now };
}

export type Claim = { ok: true; state: PublicRunState; startedAt: number; seed: number } | { ok: false; status: PublicRunStatus };

/** Takes the next start if one is allowed. The state that comes back has it recorded, so asking again at once is refused. */
export function claimPublicRun(state: PublicRunState, facts: PublicRunFacts): Claim {
	const status = publicRunStatus(state, facts);
	if (!status.canStart) {
		return { ok: false, status };
	}
	const seed = PUBLIC_RUN.seeds[state.count % PUBLIC_RUN.seeds.length] as number;
	const { failed: _cleared, ...rest } = state;
	return { ok: true, state: { ...rest, starts: [...recent(state.starts, facts.now), facts.now], count: state.count + 1 }, startedAt: facts.now, seed };
}

/**
 * Asked again at the moment a claimed start is about to reset the board. That is usually a second
 * after the claim, but it is whenever the platform gets round to running it. Returns why the start
 * must not go ahead, or null if it may: it has to be still the latest one, with the switch still
 * on, the agents still scripted, and nobody else having reset the board or begun a run since.
 */
export function refusePublicRun(state: PublicRunState, facts: PublicRunFacts, startedAt: number): string | null {
	if (!state.enabled) {
		return "public runs were switched off after this one was asked for";
	}
	if (state.starts.at(-1) !== startedAt || state.failed?.at === startedAt) {
		return "this start is no longer the latest one";
	}
	if (!facts.scripted) {
		return "the agents are set to use a model; public runs are scripted only";
	}
	if (facts.now - startedAt >= 2 * PUBLIC_RUN.startingMs) {
		return "this start was asked for too long ago to act on";
	}
	if (facts.resetAt > startedAt || facts.resetBegunAt > startedAt) {
		return "someone else reset the board after this start was asked for";
	}
	if ((facts.unsettled > 0 || facts.gateBusy) && !isStuck(facts)) {
		return "a run began on the board after this start was asked for";
	}
	return null;
}

/** Records that the start made at `startedAt` did not get going. An older start's failure is not news. */
export function failPublicRun(state: PublicRunState, startedAt: number, error: string, now: number): PublicRunState {
	return state.starts.at(-1) === startedAt ? { ...state, failed: { at: startedAt, error: error.slice(0, 300), recordedAt: now } } : state;
}

/** Forgets the starts on record: the day's runs are given back and the wait between runs ends. The switch is left as it is. */
export function clearPublicRuns(state: PublicRunState): PublicRunState {
	return { enabled: state.enabled, starts: [], count: state.count };
}
