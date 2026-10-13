import { describe, expect, it } from "vitest";
import { claimPublicRun, clearPublicRuns, failPublicRun, isScripted, newPublicRunState, PUBLIC_RUN, type PublicRunFacts, type PublicRunState, publicRunStatus, refusePublicRun } from "./public-run";

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const idle = (now: number, over: Partial<PublicRunFacts> = {}): PublicRunFacts => ({ now, scripted: true, intents: 0, unsettled: 0, gateBusy: false, lastEventAt: 0, resetAt: 0, resetBegunAt: 0, ...over });

/** Claims at `now` and returns the state afterwards. Fails the test if the claim is refused. */
function started(state: PublicRunState, facts: PublicRunFacts): PublicRunState {
	const claim = claimPublicRun(state, facts);
	if (!claim.ok) {
		throw new Error(`refused: ${claim.status.reason}`);
	}
	return claim.state;
}

describe("publicRunStatus", () => {
	it("allows a start on a board nothing has ever run on", () => {
		expect(publicRunStatus(newPublicRunState(), idle(T0))).toMatchObject({ canStart: true, reason: null, running: false, starting: false, nextAt: null, lastStartAt: null, startsToday: 0, failed: false });
	});

	it("allows a start over a finished run", () => {
		expect(publicRunStatus(newPublicRunState(), idle(T0, { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN }))).toMatchObject({ canStart: true, running: false });
	});

	it("refuses while Intents are moving, and while the gate is busy", () => {
		expect(publicRunStatus(newPublicRunState(), idle(T0, { intents: 42, unsettled: 3, lastEventAt: T0 - 1000 }))).toMatchObject({ canStart: false, reason: "running", running: true, starting: false, nextAt: null });
		expect(publicRunStatus(newPublicRunState(), idle(T0, { intents: 42, gateBusy: true, lastEventAt: T0 - 1000 }))).toMatchObject({ canStart: false, reason: "running" });
	});

	it("stops counting a run as running when nothing has happened in it for the stall time", () => {
		const stuck = idle(T0, { intents: 42, unsettled: 1, lastEventAt: T0 - PUBLIC_RUN.stallMs, resetAt: T0 - 10 * MIN });
		expect(publicRunStatus(newPublicRunState(), stuck)).toMatchObject({ canStart: true, running: false });
		expect(publicRunStatus(newPublicRunState(), { ...stuck, lastEventAt: T0 - PUBLIC_RUN.stallMs + 1 })).toMatchObject({ canStart: false, reason: "running" });
	});

	it("counts the time between a reset and the first Intent as running, whoever reset", () => {
		// No public start at all: this is an admin's reset, about to dispatch.
		expect(publicRunStatus(newPublicRunState(), idle(T0, { resetAt: T0 - 5000 }))).toMatchObject({ canStart: false, reason: "running", starting: true });
		expect(publicRunStatus(newPublicRunState(), idle(T0, { resetAt: T0 - PUBLIC_RUN.resetGraceMs + 1 }))).toMatchObject({ canStart: false, starting: true });
		expect(publicRunStatus(newPublicRunState(), idle(T0, { resetAt: T0 - PUBLIC_RUN.resetGraceMs }))).toMatchObject({ canStart: true, starting: false });
	});

	it("says a claimed start is starting until its reset has happened and Intents appear", () => {
		const state = started(newPublicRunState(), idle(T0, { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN }));
		// Claimed; the board still shows the run before.
		expect(publicRunStatus(state, idle(T0 + 2000, { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN }))).toMatchObject({ running: true, starting: true, reason: "running" });
		// Reset; nothing on the board yet. A slow dispatch is still this start, well past the grace any reset gets.
		expect(publicRunStatus(state, idle(T0 + 9000, { resetAt: T0 + 8000 }))).toMatchObject({ running: true, starting: true });
		expect(publicRunStatus(state, idle(T0 + 50_000, { resetAt: T0 + 8000 }))).toMatchObject({ running: true, starting: true });
		// The Intents are there and moving.
		expect(publicRunStatus(state, idle(T0 + 12_000, { intents: 12, unsettled: 12, resetAt: T0 + 8000, lastEventAt: T0 + 11_900 }))).toMatchObject({ running: true, starting: false });
	});

	it("says a run that finished inside the starting time is over, not starting", () => {
		const state = started(newPublicRunState(), idle(T0));
		const over = idle(T0 + 30_000, { intents: 42, unsettled: 0, resetAt: T0 + 3000, lastEventAt: T0 + 29_000 });
		expect(publicRunStatus(state, over)).toMatchObject({ running: false, starting: false, canStart: false, reason: "cooldown", nextAt: T0 + PUBLIC_RUN.cooldownMs });
	});

	it("gives up on a claimed start that never reached its reset", () => {
		const state = started(newPublicRunState(), idle(T0));
		expect(publicRunStatus(state, idle(T0 + PUBLIC_RUN.startingMs - 1))).toMatchObject({ running: true, starting: true });
		expect(publicRunStatus(state, idle(T0 + PUBLIC_RUN.startingMs))).toMatchObject({ running: false, reason: "cooldown" });
		expect(publicRunStatus(state, idle(T0 + PUBLIC_RUN.cooldownMs))).toMatchObject({ canStart: true });
	});

	it("makes the next start wait out the cooldown, counted from the last start", () => {
		const state = started(newPublicRunState(), idle(T0));
		const done = (now: number) => idle(now, { intents: 42, resetAt: T0 + 3000, lastEventAt: T0 + 90_000 });
		expect(publicRunStatus(state, done(T0 + PUBLIC_RUN.cooldownMs - 1))).toMatchObject({ canStart: false, reason: "cooldown", nextAt: T0 + PUBLIC_RUN.cooldownMs });
		expect(publicRunStatus(state, done(T0 + PUBLIC_RUN.cooldownMs))).toMatchObject({ canStart: true, reason: null, nextAt: null });
	});

	it("refuses everything when switched off, and says so before any other reason", () => {
		const off = { ...newPublicRunState(), enabled: false };
		expect(publicRunStatus(off, idle(T0))).toMatchObject({ canStart: false, reason: "off", enabled: false });
		expect(publicRunStatus(off, idle(T0, { unsettled: 3, intents: 3, lastEventAt: T0 }))).toMatchObject({ reason: "off", running: true });
	});

	it("refuses when the agents are not scripted", () => {
		expect(publicRunStatus(newPublicRunState(), idle(T0, { scripted: false }))).toMatchObject({ canStart: false, reason: "model" });
	});

	it("allows the daily number of starts and no more, and says when the oldest one ages out", () => {
		let state = newPublicRunState();
		let now = T0;
		for (let run = 0; run < PUBLIC_RUN.dailyCap; run++) {
			state = started(state, idle(now, { intents: 42, resetAt: now - MIN, lastEventAt: now - MIN }));
			now += PUBLIC_RUN.cooldownMs;
		}
		const status = publicRunStatus(state, idle(now, { intents: 42, resetAt: now - 2 * MIN, lastEventAt: now - MIN }));
		expect(status).toMatchObject({ canStart: false, reason: "cap", startsToday: PUBLIC_RUN.dailyCap, nextAt: T0 + 24 * 60 * MIN });
		// A day after the first start, there is room for one more.
		const later = T0 + 24 * 60 * MIN;
		expect(publicRunStatus(state, idle(later, { intents: 42, resetAt: now, lastEventAt: now }))).toMatchObject({ canStart: true, startsToday: PUBLIC_RUN.dailyCap - 1 });
	});

	it("the limits bound a day: at most the cap, and never two starts closer than the cooldown", () => {
		let state = newPublicRunState();
		const starts: number[] = [];
		// Someone asks every ten seconds for a day and a half; every run is over within a minute.
		for (let now = T0; now < T0 + 36 * 60 * MIN; now += 10_000) {
			const last = starts.at(-1) ?? 0;
			const claim = claimPublicRun(state, idle(now, last === 0 ? {} : { intents: 42, resetAt: last + 2000, lastEventAt: Math.min(now, last + 60_000), unsettled: now - last < 60_000 ? 5 : 0 }));
			if (claim.ok) {
				state = claim.state;
				starts.push(now);
			}
		}
		const gaps = starts.slice(1).map((at, index) => at - (starts[index] as number));
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PUBLIC_RUN.cooldownMs);
		for (const at of starts) {
			expect(starts.filter((other) => other > at - 24 * 60 * MIN && other <= at).length).toBeLessThanOrEqual(PUBLIC_RUN.dailyCap);
		}
		expect(starts.length).toBeGreaterThan(PUBLIC_RUN.dailyCap);
		expect(state.starts.length).toBeLessThanOrEqual(PUBLIC_RUN.dailyCap);
	});
});

describe("claimPublicRun", () => {
	it("records the start, so a second claim a moment later is refused", () => {
		const first = claimPublicRun(newPublicRunState(), idle(T0));
		expect(first).toMatchObject({ ok: true, startedAt: T0, seed: PUBLIC_RUN.seeds[0] });
		if (!first.ok) {
			return;
		}
		expect(first.state).toMatchObject({ starts: [T0], count: 1 });
		const second = claimPublicRun(first.state, idle(T0 + 5));
		expect(second.ok).toBe(false);
		expect(!second.ok && second.status.reason).toBe("running");
	});

	it("takes the seeds in turn", () => {
		let state = newPublicRunState();
		const seeds: number[] = [];
		for (let run = 0; run < 4; run++) {
			const claim = claimPublicRun(state, idle(T0 + run * PUBLIC_RUN.cooldownMs, { intents: run === 0 ? 0 : 42, resetAt: run === 0 ? 0 : T0 + (run - 1) * PUBLIC_RUN.cooldownMs + 1000, lastEventAt: run === 0 ? 0 : T0 + (run - 1) * PUBLIC_RUN.cooldownMs + 2000 }));
			if (!claim.ok) {
				throw new Error(`refused: ${claim.status.reason}`);
			}
			state = claim.state;
			seeds.push(claim.seed);
		}
		expect(seeds).toEqual([...PUBLIC_RUN.seeds, PUBLIC_RUN.seeds[0]]);
	});

	it("changes nothing when it refuses", () => {
		const off = { ...newPublicRunState(), enabled: false };
		expect(claimPublicRun(off, idle(T0))).toMatchObject({ ok: false, status: { reason: "off" } });
	});
});

describe("failPublicRun", () => {
	it("ends the starting state at once, keeps the cooldown, and is cleared by the next start", () => {
		const claimed = started(newPublicRunState(), idle(T0));
		// Its reset went through at T0 + 2 s; the dispatch then failed, and that was recorded at T0 + 3 s.
		const failed = failPublicRun(claimed, T0, "the fresh trunk is importing, not ready", T0 + 3000);
		expect(publicRunStatus(failed, idle(T0 + 4000, { resetAt: T0 + 2000 }))).toMatchObject({ running: false, starting: false, reason: "cooldown", failed: true });
		const again = started(failed, idle(T0 + PUBLIC_RUN.cooldownMs, { resetAt: T0 + 2000 }));
		expect(again.failed).toBeUndefined();
		expect(publicRunStatus(again, idle(T0 + PUBLIC_RUN.cooldownMs + 1000, { resetAt: T0 + 2000 }))).toMatchObject({ failed: false, starting: true });
	});

	it("does not say why in the public answer", () => {
		const failed = failPublicRun(started(newPublicRunState(), idle(T0)), T0, "internal error in repo trunk-abc: token art_v1_…", T0 + 1000);
		expect(JSON.stringify(publicRunStatus(failed, idle(T0 + 2000)))).not.toMatch(/trunk-abc|art_v1|internal error/);
	});

	it("ignores a failure reported for a start that is no longer the last one", () => {
		const first = started(newPublicRunState(), idle(T0));
		const second = started(first, idle(T0 + PUBLIC_RUN.cooldownMs, { intents: 42, resetAt: T0 + 1000, lastEventAt: T0 + 2000 }));
		expect(failPublicRun(second, T0, "late", T0 + PUBLIC_RUN.cooldownMs + 5)).toBe(second);
	});

	it("keeps a long error short", () => {
		const claimed = started(newPublicRunState(), idle(T0));
		expect(failPublicRun(claimed, T0, "x".repeat(5000), T0 + 1).failed?.error).toHaveLength(300);
	});

	it("a failure long ago does not switch off the wait after somebody else's reset", () => {
		// A start failed at T0. Half an hour later an admin resets, about to dispatch. A visitor must not get in between.
		const failed = failPublicRun(started(newPublicRunState(), idle(T0)), T0, "the fresh trunk is importing, not ready", T0 + 3000);
		const later = T0 + 30 * MIN;
		expect(publicRunStatus(failed, idle(later + 2000, { resetAt: later }))).toMatchObject({ canStart: false, reason: "running", starting: true, failed: true });
		expect(claimPublicRun(failed, idle(later + 2000, { resetAt: later })).ok).toBe(false);
		expect(publicRunStatus(failed, idle(later + PUBLIC_RUN.resetGraceMs, { resetAt: later }))).toMatchObject({ canStart: true });
	});
});

describe("a reset that is under way", () => {
	it("counts as running from the moment it begins, though the board still shows the run before at rest", () => {
		const board = { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN };
		expect(publicRunStatus(newPublicRunState(), idle(T0, board))).toMatchObject({ canStart: true });
		expect(publicRunStatus(newPublicRunState(), idle(T0 + 1000, { ...board, resetBegunAt: T0 }))).toMatchObject({ canStart: false, reason: "running", starting: true });
		expect(claimPublicRun(newPublicRunState(), idle(T0 + 40_000, { ...board, resetBegunAt: T0 })).ok).toBe(false);
	});

	it("stops counting once the reset has finished, and after five minutes if it never does", () => {
		const board = { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN };
		// Finished: the hub's own reset is later than the beginning.
		expect(publicRunStatus(newPublicRunState(), idle(T0 + 60_000, { intents: 12, unsettled: 0, resetAt: T0 + 20_000, lastEventAt: T0 + 50_000, resetBegunAt: T0 }))).toMatchObject({ running: false, canStart: true });
		expect(publicRunStatus(newPublicRunState(), idle(T0 + PUBLIC_RUN.resettingMs - 1, { ...board, resetBegunAt: T0 }))).toMatchObject({ running: true });
		expect(publicRunStatus(newPublicRunState(), idle(T0 + PUBLIC_RUN.resettingMs, { ...board, resetBegunAt: T0 }))).toMatchObject({ running: false, canStart: true });
	});

	it("keeps a second start out while the first one's own reset is slow", () => {
		// Claimed at T0; its reset began at T0 + 1 s and is still deleting forks three and a half minutes later.
		const state = started(newPublicRunState(), idle(T0, { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN }));
		const slow = idle(T0 + PUBLIC_RUN.cooldownMs + 30_000, { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN, resetBegunAt: T0 + 1000 });
		expect(publicRunStatus(state, slow)).toMatchObject({ canStart: false, reason: "running" });
	});
});

describe("a run that never ends", () => {
	it("stops counting as running fifteen minutes after its reset, however much it still says", () => {
		// An agent that waits on the ledger says so every thirty seconds, so silence alone would not catch it.
		const chatty = (now: number) => idle(now, { intents: 42, unsettled: 1, resetAt: T0, lastEventAt: now - 5000 });
		expect(publicRunStatus(newPublicRunState(), chatty(T0 + PUBLIC_RUN.maxRunMs - 1))).toMatchObject({ running: true, reason: "running" });
		expect(publicRunStatus(newPublicRunState(), chatty(T0 + PUBLIC_RUN.maxRunMs))).toMatchObject({ running: false, canStart: true });
	});
});

describe("refusePublicRun, asked when a claimed start is about to reset the board", () => {
	const before = { intents: 42, lastEventAt: T0 - 10 * MIN, resetAt: T0 - 12 * MIN };
	const claimed = started(newPublicRunState(), idle(T0, before));

	it("lets the start go ahead when nothing has changed since the claim", () => {
		expect(refusePublicRun(claimed, idle(T0 + 1500, before), T0)).toBeNull();
	});

	it("stops it if the switch was turned off in between", () => {
		expect(refusePublicRun({ ...claimed, enabled: false }, idle(T0 + 1500, before), T0)).toMatch(/switched off/);
	});

	it("stops it if the agents were set to a model in between", () => {
		expect(refusePublicRun(claimed, idle(T0 + 1500, { ...before, scripted: false }), T0)).toMatch(/scripted only/);
	});

	it("stops it if somebody else reset the board, or began to, in between", () => {
		expect(refusePublicRun(claimed, idle(T0 + 1500, { ...before, resetBegunAt: T0 + 500 }), T0)).toMatch(/someone else reset/);
		expect(refusePublicRun(claimed, idle(T0 + 9000, { intents: 0, resetAt: T0 + 4000 }), T0)).toMatch(/someone else reset/);
	});

	it("stops it if a run began on the board in between", () => {
		expect(refusePublicRun(claimed, idle(T0 + 1500, { ...before, intents: 44, unsettled: 2, lastEventAt: T0 + 1000 }), T0)).toMatch(/a run began/);
		expect(refusePublicRun(claimed, idle(T0 + 1500, { ...before, gateBusy: true, lastEventAt: T0 + 1000 }), T0)).toMatch(/a run began/);
	});

	it("still goes ahead over a run that was already stuck when the claim was allowed", () => {
		const stuck = { intents: 42, unsettled: 1, lastEventAt: T0 - PUBLIC_RUN.stallMs, resetAt: T0 - 20 * MIN };
		const state = started(newPublicRunState(), idle(T0, stuck));
		expect(refusePublicRun(state, idle(T0 + 1500, stuck), T0)).toBeNull();
	});

	it("stops a start that is no longer the latest, or is acted on far too late", () => {
		const later = started(claimed, idle(T0 + PUBLIC_RUN.cooldownMs, { intents: 42, resetAt: T0 + 3000, lastEventAt: T0 + 90_000 }));
		expect(refusePublicRun(later, idle(T0 + PUBLIC_RUN.cooldownMs + 1000, before), T0)).toMatch(/no longer the latest/);
		expect(refusePublicRun(claimed, idle(T0 + 2 * PUBLIC_RUN.startingMs, before), T0)).toMatch(/too long ago/);
		expect(refusePublicRun(claimed, idle(T0 + 2 * PUBLIC_RUN.startingMs - 1, before), T0)).toBeNull();
	});

	it("stops a start that has already been recorded as failed", () => {
		expect(refusePublicRun(failPublicRun(claimed, T0, "could not be handed to a Workflow", T0 + 10), idle(T0 + 1500, before), T0)).toMatch(/no longer the latest/);
	});
});

describe("clearPublicRuns", () => {
	it("gives the day's runs back and ends the wait, and leaves the switch alone", () => {
		let state = newPublicRunState();
		let now = T0;
		for (let run = 0; run < PUBLIC_RUN.dailyCap; run++) {
			state = started(state, idle(now, { intents: 42, resetAt: now - MIN, lastEventAt: now - MIN }));
			now += PUBLIC_RUN.cooldownMs;
		}
		const board = idle(now - PUBLIC_RUN.cooldownMs + 90_000, { intents: 42, resetAt: now - PUBLIC_RUN.cooldownMs + 3000, lastEventAt: now - PUBLIC_RUN.cooldownMs + 80_000 });
		expect(publicRunStatus(state, board)).toMatchObject({ canStart: false, reason: "cap" });
		expect(publicRunStatus(clearPublicRuns(state), board)).toMatchObject({ canStart: true, startsToday: 0, lastStartAt: null });
		expect(clearPublicRuns({ ...state, enabled: false })).toMatchObject({ enabled: false, starts: [], count: PUBLIC_RUN.dailyCap });
	});
});

describe("isScripted", () => {
	it("goes by the provider chosen at run time, then the configured one, then scripted", () => {
		expect(isScripted(null, "scripted")).toBe(true);
		expect(isScripted(null, undefined)).toBe(true);
		expect(isScripted(null, "  ")).toBe(true);
		expect(isScripted(null, "google")).toBe(false);
		expect(isScripted({ provider: "google" }, "scripted")).toBe(false);
		expect(isScripted({ provider: "scripted" }, "google")).toBe(true);
	});
});
