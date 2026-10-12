// Attempts to break the gate's pure logic after it was fixed: what "the same work" means once the trunk the
// stopped work started from is known, what a duplicate stale report does, and what counts as calling a
// function. Written by an independent verifier (2026-10-12, second pass) and kept as regression tests.
// "SAFE" tests assert the safe behaviour; "CHARACTERISE" tests record what happens at a known limit.
import { describe, expect, it } from "vitest";
import type { Intent, IntentStatus, Premise } from "../../shared/types";
import { unanswered } from "../agent/tools";
import { callsFunction, isAbout, withdrawOwn, withoutComments } from "../intent/premises";
import type { Reader } from "../ledger/ledger-shard";
import { applyChanges } from "../ports/memory-repo-store";
import type { FileMap } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";
import { demoFiles, demoWith, referencePatch } from "../testing/demo";
import { sameAsStopped } from "./gate";
import { type InvalidateDeps, invalidateWith, type Landed } from "./invalidate";
import { MemoryRederiveStore, RederiveScheduler } from "./rederive";

const lines = (...items: string[]) => `${items.join("\n")}\n`;
const say = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

describe("C2 sameAsStopped with the trunk the stopped work started from", () => {
	const old: FileMap = { "src/a.ts": lines("a1", "a2", "a3", "a4", "a5", "a6"), "src/b.ts": lines("b1", "b2"), "src/gone.ts": lines("g1"), "tests/a.test.ts": "t0" };

	it("SAFE: files ADDED by the stopped work. Added again the same = same; left out, or added with other content = different", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6"), "src/new.ts": lines("n1") };
		const trunk = { ...old, "src/b.ts": lines("b1-LANDER", "b2") };
		const again = { ...trunk, "src/a.ts": stopped["src/a.ts"], "src/new.ts": lines("n1") };
		expect(sameAsStopped(trunk, again, stopped, old)).toEqual(["src/a.ts", "src/new.ts"]);
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] }, stopped, old)).toBeNull();
		expect(sameAsStopped(trunk, { ...again, "src/new.ts": lines("n1-other") }, stopped, old)).toBeNull();
	});

	it("SAFE: files DELETED by the stopped work. Deleted again = same; kept = different; and when the landing changed the deleted file", () => {
		const { "src/gone.ts": _gone, ...withoutGone } = old;
		const stopped: FileMap = { ...withoutGone, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6") };
		const trunk: FileMap = { ...old, "src/b.ts": lines("b1-LANDER", "b2") };
		const { "src/gone.ts": _g2, ...trunkWithoutGone } = trunk;
		const again: FileMap = { ...trunkWithoutGone, "src/a.ts": stopped["src/a.ts"] as string };
		expect(sameAsStopped(trunk, again, stopped, old)).toEqual(["src/a.ts", "src/gone.ts"]);
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] as string }, stopped, old)).toBeNull();
		// The landing changed the file the stopped work deleted (a delete against an edit cannot be carried).
		const trunk2 = { ...old, "src/gone.ts": lines("g1-LANDER") };
		const { "src/gone.ts": _g3, ...trunk2WithoutGone } = trunk2;
		expect(sameAsStopped(trunk2, { ...trunk2WithoutGone, "src/a.ts": stopped["src/a.ts"] as string }, stopped, old)).toEqual(["src/a.ts", "src/gone.ts"]);
		expect(sameAsStopped(trunk2, { ...trunk2, "src/a.ts": stopped["src/a.ts"] as string }, stopped, old)).toBeNull();
	});

	it("SAFE: the identical edit, where the landing changed the same file two lines away, is the same; a different edit is not", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3", "a4", "a5-EDIT", "a6") };
		const trunk = { ...old, "src/a.ts": lines("a1-LANDER", "a2", "a3", "a4", "a5", "a6") };
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": lines("a1-LANDER", "a2", "a3", "a4", "a5-EDIT", "a6") }, stopped, old)).toEqual(["src/a.ts"]);
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": lines("a1-LANDER", "a2", "a3", "a4", "a5-OTHER", "a6") }, stopped, old)).toBeNull();
	});

	it("SAFE (break attempt): the identical edit, where the landing changed the ADJACENT line, should still be recognised as the stopped work over again", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6") };
		const trunk = { ...old, "src/a.ts": lines("a1", "a2-LANDER", "a3", "a4", "a5", "a6") };
		const redo = { ...trunk, "src/a.ts": lines("a1", "a2-LANDER", "a3-EDIT", "a4", "a5", "a6") };
		const verdict = sameAsStopped(trunk, redo, stopped, old);
		say("C2 adjacent-line: same edit on the new file", verdict);
		// What IS called the same in that case: the stopped file whole, which throws the landing's line away.
		say("C2 adjacent-line: the stopped file written whole (drops the landing's change)", sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] }, stopped, old));
		expect(verdict).toEqual(["src/a.ts"]);
	});

	it("CHARACTERISE: same LINE changed by both (a true conflict): the edit re-applied to the landing's line is called different, the stopped file whole is called the same", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3 + catch", "a4", "a5", "a6") };
		const trunk = { ...old, "src/a.ts": lines("a1", "a2", "a3-LANDER", "a4", "a5", "a6") };
		const reapplied = sameAsStopped(trunk, { ...trunk, "src/a.ts": lines("a1", "a2", "a3-LANDER + catch", "a4", "a5", "a6") }, stopped, old);
		const whole = sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] }, stopped, old);
		say("C2 same-line conflict", { reapplied, whole });
		expect(reapplied).toBeNull();
		expect(whole).toEqual(["src/a.ts"]);
	});

	it("CHARACTERISE: a redo that reformats one line, or adds one unrelated source file, is called different (so it is run)", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6") };
		const trunk = { ...old, "src/b.ts": lines("b1-LANDER", "b2") };
		const reformatted = sameAsStopped(trunk, { ...trunk, "src/a.ts": lines("a1", "a2", "a3-EDIT ", "a4", "a5", "a6") }, stopped, old);
		const extraFile = sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"], "src/extra.ts": "// nothing\n" }, stopped, old);
		const extraComment = sameAsStopped(trunk, { ...trunk, "src/a.ts": `${stopped["src/a.ts"]}// same logic\n` }, stopped, old);
		say("C2 trivially different redo", { reformatted, extraFile, extraComment });
		expect([reformatted, extraFile, extraComment]).toEqual([null, null, null]);
	});

	it("CHARACTERISE: stopped work that touched only tests is never 'the same', and a redo that differs only in tests is the same", () => {
		const stoppedTestsOnly = { ...old, "tests/a.test.ts": "t1-stand-in-throws" };
		const trunk = { ...old, "src/b.ts": lines("b1-LANDER", "b2") };
		const testsOnly = sameAsStopped(trunk, { ...trunk, "tests/a.test.ts": "t1-stand-in-throws" }, stoppedTestsOnly, old);
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6"), "tests/a.test.ts": "t1" };
		const otherTests = sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"], "tests/a.test.ts": "t2-rewritten" }, stopped, old);
		say("C2 tests", { testsOnly, otherTests });
		expect(testsOnly).toBeNull();
		expect(otherTests).toEqual(["src/a.ts"]);
	});

	it("CHARACTERISE: no recorded base (an Intent stopped before this change): whole files are compared, with both of the old faults", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6"), "src/b.ts": lines("b1", "b2-EDIT") };
		const trunk = { ...old, "src/gone.ts": lines("g1-LANDER") };
		const subset = sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] }, stopped);
		const stopped2 = { ...old, "src/a.ts": lines("a1", "a2", "a3", "a4", "a5-EDIT", "a6") };
		const trunk2 = { ...old, "src/a.ts": lines("a1-LANDER", "a2", "a3", "a4", "a5", "a6") };
		const sameEdit = sameAsStopped(trunk2, { ...trunk2, "src/a.ts": lines("a1-LANDER", "a2", "a3", "a4", "a5-EDIT", "a6") }, stopped2);
		say("C2 legacy (no base)", { subsetCalledSame: subset, sameEditOnTouchedFile: sameEdit });
		expect(subset).toEqual(["src/a.ts"]);
		expect(sameEdit).toBeNull();
	});

	it("SAFE: part of the stopped work is already on the new trunk (someone landed the same change): redoing the rest is the same, and redoing nothing is not", () => {
		const stopped = { ...old, "src/a.ts": lines("a1", "a2", "a3-EDIT", "a4", "a5", "a6"), "src/b.ts": lines("b1", "b2-EDIT") };
		const trunk = { ...old, "src/b.ts": lines("b1", "b2-EDIT") };
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": stopped["src/a.ts"] }, stopped, old)).toEqual(["src/a.ts"]);
		expect(sameAsStopped(trunk, { ...trunk }, stopped, old)).toBeNull();
		expect(sameAsStopped(trunk, { ...trunk, "src/a.ts": lines("a1", "a2", "a3-BETTER", "a4", "a5", "a6") }, stopped, old)).toBeNull();
	});

	it("SAFE, with the demo repo: t11's old logic redone on a trunk where t01 landed AND rate-limit.ts itself was changed far from t11's edit is the same; t11-rederived is not", () => {
		const oldTrunk = demoFiles();
		const stopped = applyChanges(oldTrunk, referencePatch("t11"));
		const path = "src/auth/rate-limit.ts";
		const header = "// A note the landing added at the top of this file.\n";
		const trunk = { ...demoWith("t01"), [path]: `${header}${oldTrunk[path] ?? ""}` };
		const redo = { ...trunk, [path]: `${header}${stopped[path] ?? ""}`, ...Object.fromEntries(Object.entries(referencePatch("t11")).filter(([file]) => file.startsWith("tests/"))) } as FileMap;
		const verdict = sameAsStopped(trunk, redo, stopped, oldTrunk);
		const rederived = sameAsStopped(trunk, { ...trunk, [path]: `${header}${applyChanges(oldTrunk, referencePatch("t11-rederived"))[path] ?? ""}` }, stopped, oldTrunk);
		say("C2 demo repo", { sameEditOnChangedFile: verdict, rederived });
		expect(verdict).toEqual([path]);
		expect(rederived).toBeNull();
	});
});

describe("C4 a duplicate report that an Intent is stale", () => {
	it("SAFE: the scheduler keeps one entry per Intent: a second report while it waits, or while it runs, adds nothing, and one race is started", async () => {
		const store = new MemoryRederiveStore();
		const started: string[] = [];
		const scheduler = new RederiveScheduler(store, 3, async (entry) => (started.push(entry.intentId), { kind: "running", attempt: 1 }));
		expect(scheduler.noteStale({ intentId: "ix", priority: 1, since: 1 })).toBe(true);
		expect(scheduler.noteStale({ intentId: "ix", priority: 1, since: 2 })).toBe(false);
		await scheduler.pump();
		expect(scheduler.noteStale({ intentId: "ix", priority: 1, since: 3 })).toBe(false);
		await scheduler.pump();
		say("C4 scheduler", { started, waiting: store.waiting().length, running: store.running().length });
		expect(started).toEqual(["ix"]);
		expect(store.running()).toHaveLength(1);
		expect(store.waiting()).toHaveLength(0);
	});

	const VERIFY = "src/auth/session.ts#verifySession";
	const asserted = (id: string): Premise => ({ symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: { id, description: id, code: "", imports: [] } });
	const landed: Landed = { commit: "c".repeat(40), byIntent: "ilander01", changedSymbols: [VERIFY], newTrunkFiles: {} };
	function world(statuses: Record<string, IntentStatus>, breakPremise: InvalidateDeps["breakPremise"]): InvalidateDeps {
		const intents: Record<string, Pick<Intent, "id" | "premises">> = Object.fromEntries(Object.keys(statuses).map((id) => [id, { id, premises: [asserted("a1")] }]));
		const readers: Reader[] = Object.keys(statuses).map((intentId) => ({ intentId, symbol: VERIFY, surfaceHash: "h" }));
		return {
			claimCommit: async () => true,
			registry: async () => Object.entries(statuses).map(([id, status]) => ({ id, status })),
			readersOf: async () => readers,
			asserters: async () => Object.keys(intents),
			getIntent: async (id) => intents[id] ?? null,
			breakPremise,
			run: async (req: RunRequest): Promise<RunResult> => ({ tests: [], assertions: req.assertions.map((item) => ({ id: item.id, ok: false, error: "x", ms: 1 })) }),
			publishMetrics: async () => undefined,
		};
	}

	it("SAFE: an Intent the registry already shows as stale (from an earlier landing) is not touched, so it is not returned again", async () => {
		const calls: string[] = [];
		const result = await invalidateWith(world({ iold: "stale", inew: "queued" }, async (id) => (calls.push(id), { broken: true, stale: true })), landed);
		say("C4 already stale in the registry", { calls: [...new Set(calls)], stale: result.stale });
		expect([...new Set(calls)]).toEqual(["inew"]);
		expect(result.stale).toEqual(["inew"]);
	});

	it("CHARACTERISE: the registry lags (says `queued`), the Intent is in fact already stale from an earlier landing, and the first call to it fails without doing anything: it IS returned as stale by this landing too", async () => {
		let failed = false;
		const result = await invalidateWith(
			world({ ilag: "queued" }, async () => {
				if (!failed) {
					failed = true;
					throw new Error("Durable Object is overloaded"); // nothing was applied
				}
				return { broken: false, stale: true }; // already broken, already stale: an earlier landing did it
			}),
			landed,
		);
		say("C4 lagging registry + one failed call", { stale: result.stale, brokenListedByThisCall: result.broken.length });
		expect(result.stale).toEqual(["ilag"]);
	});

	it("SAFE: a re-derive in progress that only has a type-surface change (IntentDO answers not broken, not stale) is not returned even after a failed try", async () => {
		let failed = false;
		const result = await invalidateWith(
			world({ irun: "rederiving" }, async (_id, _symbol, _by, scope) => {
				if (!failed) {
					failed = true;
					throw new Error("Network connection lost.");
				}
				return scope !== undefined && "sources" in scope ? { broken: false, stale: false } : { broken: false, stale: false };
			}),
			landed,
		);
		expect(result.stale).toEqual([]);
	});
});

describe("C5 what counts as calling a function, after the change (premises.ts)", () => {
	const VERIFY = "src/auth/session.ts#verifySession";
	const premise = (code: string, symbol = "src/billing/tax.ts#taxFor", state: Premise["state"] = "holding"): Premise => ({ symbol, source: "asserted", surfaceHash: null, state, assertion: { id: "a1", description: "d", code, imports: [] } });
	const broke = premise("", VERIFY, "broken");

	it("SAFE: the claimed cases. A comment and a method on something else do not count; a direct call does", () => {
		expect(isAbout(premise("taxFor(1); // verifySession()"), VERIFY)).toBe(false);
		expect(isAbout(premise("taxFor(1); /* verifySession( */"), VERIFY)).toBe(false);
		expect(isAbout(premise("store.verifySession('a'); taxFor(1);"), VERIFY)).toBe(false);
		expect(isAbout(premise("assert.eq(verifySession('s1', store, () => 10), null);"), VERIFY)).toBe(true);
		expect(isAbout(premise("assert.eq( verifySession ('s1'), null);"), VERIFY)).toBe(true);
	});

	it("SAFE (regression check): a REAL call written through a namespace of the imported file, `session.verifySession(...)`, is still an assertion about verifySession", () => {
		// What tidyAssertion makes of `import * as session from "src/auth/session.ts"`: an object of that file's exports.
		const code = "const session = { SessionExpiredError, createSession, verifySession };\nconst store = createMemorySessionStore([]);\nassert.eq(session.verifySession('s1', store, () => 10), null);";
		say("C5 namespace call", { callsFunction: callsFunction(code, "verifySession"), isAbout: isAbout(premise(code, "src/auth/session.ts#SessionExpiredError"), VERIFY) });
		expect(isAbout(premise(code, "src/auth/session.ts#SessionExpiredError"), VERIFY)).toBe(true);
		// So the redo question is answered by it, and it is withdrawn when the Intent goes on to change verifySession.
		expect(unanswered([broke], [premise(code, "src/auth/session.ts#SessionExpiredError")], [])).toEqual([]);
		expect(withdrawOwn([premise(code, "src/auth/session.ts#SessionExpiredError")], [VERIFY]).withdrawn).toHaveLength(1);
	});

	it("CHARACTERISE: a name inside a string still counts as a call; code after a string holding `//` on the same line is thrown away as a comment", () => {
		const inString = isAbout(premise('taxFor(1); const s = "verifySession(";'), VERIFY);
		const afterSlashes = callsFunction('assert.eq(clean("a//b"), "a/b"); assert.eq(verifySession("s1"), null);', "verifySession");
		say("C5 strings", { nameInStringCounts: inString, realCallAfterSlashStringCounts: afterSlashes, stripped: withoutComments('x("a//b"); verifySession("s1");') });
		expect(inString).toBe(true);
		expect(afterSlashes).toBe(false);
	});
});
