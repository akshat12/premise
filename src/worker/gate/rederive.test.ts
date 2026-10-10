import { describe, expect, it } from "vitest";
import { MemoryRederiveStore, RederiveScheduler, type StaleEntry, type Started } from "./rederive";

const entry = (intentId: string, priority = 5, since = 0): StaleEntry => ({ intentId, priority, since });

/** A scheduler whose `start` records what it was asked to start and holds a slot unless told otherwise. */
function harness(cap: number, outcome: (id: string) => Started | Error = () => ({ kind: "running", attempt: 1 })) {
	const store = new MemoryRederiveStore();
	const started: string[] = [];
	let most = 0;
	const scheduler = new RederiveScheduler(
		store,
		cap,
		async (item) => {
			started.push(item.intentId);
			most = Math.max(most, store.running().length);
			const result = outcome(item.intentId);
			if (result instanceof Error) {
				throw result;
			}
			return result;
		},
		() => 1000,
	);
	const running = () => store.running().map((item) => item.intentId);
	const waiting = () => store.waiting().map((item) => item.intentId);
	return { store, scheduler, started, running, waiting, most: () => most };
}

describe("RederiveScheduler", () => {
	it("runs at most `cap` re-derives at once: of five stale Intents, three start and two wait", async () => {
		const h = harness(3);
		for (const id of ["a", "b", "c", "d", "e"]) {
			expect(h.scheduler.noteStale(entry(id, 5, h.started.length))).toBe(true);
		}
		expect(await h.scheduler.pump()).toEqual(["a", "b", "c"]);
		expect(h.running()).toEqual(["a", "b", "c"]);
		expect(h.waiting()).toEqual(["d", "e"]);
		// Pumping again changes nothing while all the slots are taken.
		expect(await h.scheduler.pump()).toEqual([]);
		expect(h.most()).toBe(3);
	});

	it("starts the next one when a slot frees up", async () => {
		const h = harness(3);
		["a", "b", "c", "d", "e"].forEach((id, index) => h.scheduler.noteStale(entry(id, 5, index)));
		await h.scheduler.pump();
		h.scheduler.finished("b");
		expect(await h.scheduler.pump()).toEqual(["d"]);
		expect(h.running()).toEqual(["a", "c", "d"]);
		h.scheduler.finished("a");
		h.scheduler.finished("c");
		expect(await h.scheduler.pump()).toEqual(["e"]);
		expect(h.waiting()).toEqual([]);
		expect(h.most()).toBe(3);
	});

	it("takes the lowest priority number first, then whoever has waited longest", async () => {
		const h = harness(2);
		h.scheduler.noteStale(entry("late-high", 1, 50));
		h.scheduler.noteStale(entry("early-low", 9, 1));
		h.scheduler.noteStale(entry("early-high", 1, 10));
		h.scheduler.noteStale(entry("mid", 4, 5));
		expect(h.scheduler.next().map((item) => item.intentId)).toEqual(["early-high", "late-high"]);
		expect(await h.scheduler.pump()).toEqual(["early-high", "late-high"]);
		h.scheduler.finished("early-high");
		expect(await h.scheduler.pump()).toEqual(["mid"]);
	});

	it("does not queue an Intent that is already waiting or running", async () => {
		const h = harness(1);
		expect(h.scheduler.noteStale(entry("a"))).toBe(true);
		expect(h.scheduler.noteStale(entry("a"))).toBe(false);
		await h.scheduler.pump();
		expect(h.scheduler.noteStale(entry("a"))).toBe(false);
		expect(h.waiting()).toEqual([]);
		expect(h.started).toEqual(["a"]);
	});

	it("a race that is over as soon as it starts does not hold a slot", async () => {
		// The rebase landed, or the Intent was no longer stale: nothing is left running.
		const h = harness(1, (id) => (id === "c" ? { kind: "running", attempt: 2 } : { kind: "done" }));
		["a", "b", "c", "d"].forEach((id, index) => h.scheduler.noteStale(entry(id, 5, index)));
		expect(await h.scheduler.pump()).toEqual(["a", "b", "c"]);
		expect(h.store.running()).toEqual([{ intentId: "c", attempt: 2, started: 1000 }]);
		expect(h.waiting()).toEqual(["d"]);
		expect(h.most()).toBe(1); // even so, never more than the cap at one moment
	});

	it("frees the slot if starting throws, and lets the error out", async () => {
		const h = harness(2, (id) => (id === "a" ? new Error("fork failed") : { kind: "running", attempt: 1 }));
		h.scheduler.noteStale(entry("a", 1));
		h.scheduler.noteStale(entry("b", 2));
		await expect(h.scheduler.pump()).rejects.toThrow("fork failed");
		expect(h.running()).toEqual([]);
		// The one that threw is no longer queued; the caller decides whether to put it back.
		expect(h.waiting()).toEqual(["b"]);
		expect(await h.scheduler.pump()).toEqual(["b"]);
	});

	it("isRunning, finished and drop", async () => {
		const h = harness(1);
		h.scheduler.noteStale(entry("a", 1));
		h.scheduler.noteStale(entry("b", 2));
		await h.scheduler.pump();
		expect(h.scheduler.isRunning("a")).toEqual({ intentId: "a", attempt: 1, started: 1000 });
		expect(h.scheduler.isRunning("b")).toBeUndefined();
		h.scheduler.drop("b");
		h.scheduler.drop("a");
		expect(h.running()).toEqual([]);
		expect(h.waiting()).toEqual([]);
		h.scheduler.finished("never-there");
	});
});
