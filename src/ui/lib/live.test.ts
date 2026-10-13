import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import mainRun from "../../../demo/runs/main.json";
import scaleRun from "../../../demo/runs/scale.json";
import { countdown, liveCaption, type LiveCaption, type LiveStatus, runOver, runSettled, SETTLE_MS, startOffer } from "./live";
import { readRecording } from "./recording";
import { reduceAll } from "./reduce";
import { storyFor } from "./story";

const main = readRecording(mainRun).events;
const scale = readRecording(scaleRun).events;
const MOMENT = { starting: false, store: "artifacts", workload: 30 };

/** Whether a watcher would have been told the run was over with `shown` events on screen: the board at rest, and nothing more for a moment. */
function settled(events: readonly PremiseEvent[], shown: number): boolean {
	const log = events.slice(0, shown);
	const next = events[shown];
	// Just before the next event arrives is the longest the log has been silent.
	return runSettled(log, reduceAll(log).intents, next === undefined ? Number.POSITIVE_INFINITY : next.ts - 1);
}

/** The captions a watcher of the live board would have seen, had this recorded run been live: one for each distinct sentence, in order. */
function watched(events: readonly PremiseEvent[], every: number): LiveCaption[] {
	const seen: LiveCaption[] = [];
	for (let shown = 0; ; shown = Math.min(events.length, shown + every)) {
		const log = events.slice(0, shown);
		const caption = liveCaption(log, storyFor(log), { ...MOMENT, over: settled(events, shown) });
		if (seen.at(-1)?.id !== caption.id) {
			seen.push(caption);
		}
		if (shown === events.length) {
			return seen;
		}
	}
}

describe("liveCaption, following a run as it happens", () => {
	it("tells the four-agent run in the story's words, and only sums it up once it is over", () => {
		const captions = watched(main, 1);
		expect(captions.map((caption) => caption.title)).toEqual([
			"Nothing is running. Start a run and watch it happen.",
			"The agents start work on the same code at the same time.",
			"Premise records what each one relies on.",
			// The first of the two to be stopped is on screen for an instant before the second is.
			"Agent 2 relied on how it used to behave. It is stopped at once.",
			"Agent 2's tests fail on the new code. Its work is redone and lands.",
			"Agent 4's tests all still pass. Only its premise caught the problem.",
			"Everything landed. Nothing broken reached trunk.",
		]);
		// The last sentence is the story's own last step, with the point of the run said once more.
		const end = storyFor(main).steps.at(-1);
		expect(captions.at(-1)).toMatchObject({ id: "end", title: end?.title });
		expect(captions.at(-1)?.body).toBe(`${end?.body} Agent 4's tests all passed on the new code. Only its premise caught the problem.`);
	});

	it("says how many were stopped once all of them have been", () => {
		const story = storyFor(main);
		const at = story.steps.find((step) => step.id === "stopped")?.at ?? 0;
		const log = main.slice(0, at);
		expect(liveCaption(log, storyFor(log), { ...MOMENT, over: false })).toMatchObject({ id: "stopped", title: "Two agents relied on how it used to behave. They are stopped at once." });
	});

	it("does not sum the run up in the second between the last landing and the events that follow it", () => {
		// The last Intent's status says "landed" five events before the log ends. A summary written then says one agent did not land.
		const early = main.reduce((found, event, index) => (event.t === "intent.status" && event.status === "landed" ? index + 1 : found), 0);
		expect(early).toBeLessThan(main.length);
		const log = main.slice(0, early);
		expect(runOver(reduceAll(log).intents)).toBe(true);
		expect(storyFor(log).steps.at(-1)?.body).toMatch(/did not land/);
		expect(settled(main, early)).toBe(false);
		expect(liveCaption(log, storyFor(log), { ...MOMENT, over: settled(main, early) }).id).not.toBe("end");
		// Once the log has been silent for a moment, it is.
		const last = main.at(-1) as PremiseEvent;
		expect(runSettled(main, reduceAll(main).intents, last.ts + SETTLE_MS - 1)).toBe(false);
		expect(runSettled(main, reduceAll(main).intents, last.ts + SETTLE_MS)).toBe(true);
	});

	it("says nothing about premises catching anything in a run where none did", () => {
		const plain = main.filter((event) => !(event.t === "gate.result" && event.report.path === "rebase" && !event.report.ok && event.report.tests.failed.length === 0));
		expect(liveCaption(plain, storyFor(plain), { ...MOMENT, over: true }).body).not.toMatch(/premise caught/);
	});

	it("never says a run is over while an Intent is still moving", () => {
		for (const [events, every] of [
			[main, 1],
			// The larger log is some thousands of events, and each look at it reads all of it: a look every 150 events is enough.
			[scale, 150],
		] as const) {
			for (let shown = every; shown < events.length; shown += every) {
				const log = events.slice(0, shown);
				const intents = reduceAll(log).intents;
				const caption = liveCaption(log, storyFor(log), { ...MOMENT, over: settled(events, shown) });
				if (!runOver(intents)) {
					expect(`${caption.title} ${caption.body}`, `after ${shown} events`).not.toMatch(/is over|landed\. Nothing|Everything landed/);
				}
			}
		}
	}, 30_000);

	it("follows the twelve-agent run too, and lights the rows each sentence is about", () => {
		const captions = watched(scale, 100);
		expect(captions[0]?.id).toBe("idle");
		expect(captions[1]?.id).toBe("start");
		expect(captions.at(-1)?.id).toBe("end");
		const stopped = captions.find((caption) => caption.id === "stopped");
		expect(stopped?.step?.focus.length).toBeGreaterThan(0);
		expect(stopped?.title).toMatch(/relied on how it used to behave/);
		// Every sentence in between is one of the story's steps.
		const steps = new Set(storyFor(scale).steps.map((step) => step.id));
		for (const caption of captions.slice(1, -1).filter((item) => item.step !== undefined)) {
			expect(steps.has(caption.id), caption.id).toBe(true);
		}
	}, 30_000);

	it("says a run is starting, whatever the board still shows", () => {
		const caption = liveCaption(main, storyFor(main), { ...MOMENT, starting: true, over: true });
		expect(caption).toMatchObject({ id: "starting", title: "Starting a run." });
		expect(caption.body).toMatch(/real Cloudflare Artifacts/);
		expect(liveCaption([], storyFor([]), { ...MOMENT, store: "memory", starting: true, over: false }).body).toMatch(/in-memory repos/);
	});

	it("says what a run is before one has started, and where it would run", () => {
		const idle = liveCaption([], storyFor([]), { ...MOMENT, over: false });
		expect(idle.id).toBe("idle");
		expect(idle.body).toMatch(/Twelve agents and 30 scripted workload Intents, on real Cloudflare Artifacts/);
		expect(idle.body).toMatch(/replay prepared edits/);
	});

	it("says so when there is no Worker behind the page, and does not invite a start", () => {
		const caption = liveCaption([], storyFor([]), { ...MOMENT, unreachable: true, over: false });
		expect(caption.id).toBe("unreachable");
		expect(`${caption.title} ${caption.body}`).not.toMatch(/Start a run/);
		expect(caption.body).toMatch(/Demo tab plays a run/);
		// A board that is on screen is still described, whatever the last request did.
		expect(liveCaption(main, storyFor(main), { ...MOMENT, unreachable: true, over: true }).id).toBe("end");
	});

	it("has something true to say about a finished run in which no premise broke", () => {
		const quiet = main.filter((event) => event.t !== "premise.broken");
		const caption = liveCaption(quiet, storyFor(quiet), { ...MOMENT, over: true });
		expect(caption).toMatchObject({ id: "over", title: "The run is over." });
		expect(caption.body).toMatch(/^4 Intents landed\./);
	});
});

describe("runSettled", () => {
	it("is never true of an empty board", () => {
		expect(runSettled([], {}, Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("runOver", () => {
	it("is false for an empty board, and true only when every Intent has come to rest", () => {
		expect(runOver({})).toBe(false);
		expect(runOver({ a: { status: "landed" }, b: { status: "failed" }, c: { status: "escalated" }, d: { status: "quarantined" } })).toBe(true);
		for (const status of ["planning", "claiming", "waiting", "working", "submitted", "checking", "queued", "gating", "stale", "rederiving"] as const) {
			expect(runOver({ a: { status: "landed" }, b: { status } }), status).toBe(false);
		}
	});
});

describe("countdown", () => {
	it("counts in minutes and seconds, rounding up, and stops at zero", () => {
		expect(countdown(125_000)).toBe("2:05");
		expect(countdown(9_000)).toBe("0:09");
		expect(countdown(8_001)).toBe("0:09");
		expect(countdown(0)).toBe("0:00");
		expect(countdown(-5000)).toBe("0:00");
	});
});

describe("startOffer", () => {
	const NOW = 1_800_000_000_000;
	const status = (over: Partial<LiveStatus> = {}): LiveStatus => ({ enabled: true, running: false, starting: false, canStart: true, reason: null, nextAt: null, lastStartAt: null, startsToday: 0, dailyCap: 40, workload: 30, failed: false, now: NOW, ...over });
	const quiet = { asking: false, unreachable: false };

	it("offers a start only when the Worker says one is allowed", () => {
		expect(startOffer(status(), NOW, quiet)).toMatchObject({ ready: true, label: "Start a run" });
		expect(startOffer(status({ lastStartAt: NOW - 600_000 }), NOW, quiet)).toMatchObject({ ready: true, label: "Start a new run" });
		for (const reason of ["off", "model", "running", "cooldown", "cap"] as const) {
			expect(startOffer(status({ canStart: false, reason, nextAt: NOW + 60_000 }), NOW, quiet).ready, reason).toBe(false);
		}
	});

	it("is not ready before the Worker has answered, or while a start is being sent", () => {
		expect(startOffer(null, NOW, quiet)).toMatchObject({ ready: false, note: "" });
		expect(startOffer(status(), NOW, { asking: true, unreachable: false })).toMatchObject({ ready: false, label: "Starting…" });
	});

	it("says so when there is no Worker to ask", () => {
		const offer = startOffer(null, NOW, { asking: false, unreachable: true });
		expect(offer.ready).toBe(false);
		expect(offer.note).toMatch(/Demo tab plays a recorded run/);
	});

	it("counts down the wait between runs", () => {
		expect(startOffer(status({ canStart: false, reason: "cooldown", nextAt: NOW + 95_000, lastStartAt: NOW - 85_000 }), NOW, quiet)).toMatchObject({ ready: false, label: "Next run in 1:35" });
	});

	it("tells starting from running", () => {
		expect(startOffer(status({ canStart: false, reason: "running", running: true, starting: true }), NOW, quiet).label).toBe("Starting…");
		expect(startOffer(status({ canStart: false, reason: "running", running: true }), NOW, quiet)).toMatchObject({ label: "Running…", note: "A run is in progress. The next one can start when it is over." });
	});

	it("says why when runs are off, and when the day's runs are used", () => {
		expect(startOffer(status({ canStart: false, reason: "off", enabled: false }), NOW, quiet).note).toMatch(/switched off/);
		expect(startOffer(status({ canStart: false, reason: "model" }), NOW, quiet).note).toMatch(/live model/);
		expect(startOffer(status({ canStart: false, reason: "cap", nextAt: NOW + 5 * 3_600_000 }), NOW, quiet).note).toBe("Today's 40 runs have been used. The next can start in about 5 hours.");
		expect(startOffer(status({ canStart: false, reason: "cap", nextAt: NOW + 12 * 60_000 }), NOW, quiet).note).toMatch(/in 12 minutes\.$/);
	});

	it("mentions a start that failed, while it is the latest news", () => {
		expect(startOffer(status({ canStart: false, reason: "cooldown", nextAt: NOW + 30_000, failed: true }), NOW, quiet).note).toMatch(/^The last run could not start\./);
		expect(startOffer(status({ failed: true, lastStartAt: NOW - 600_000 }), NOW, quiet)).toMatchObject({ ready: true, note: "The last run could not start. Try again." });
	});

	it("goes by the Worker's yes or no, and stays off for a reason it has never heard of", () => {
		// A newer Worker may refuse for a reason this page does not know. The button is off and still says something.
		const unknown = startOffer(status({ canStart: false, reason: "maintenance" as never }), NOW, quiet);
		expect(unknown.ready).toBe(false);
		expect(unknown.note).not.toBe("");
		// And "yes" is yes even if a reason came with it.
		expect(startOffer(status({ canStart: true, reason: "cooldown" }), NOW, quiet).ready).toBe(true);
	});
});
