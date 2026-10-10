import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Premise } from "../../shared/types";
import realRun from "../fixtures/real-run.json";
import { type IntentView, reduceAll } from "./reduce";
import { annotation, baysReached, callsign, chipsFor, lanesOf, layoutFor, ledgerRows, shortSha, STATUS_LOOK, symbolFile, symbolName, touches, waitingOn } from "./view";

const VERIFY = "src/auth/session.ts#verifySession";
const LOGIN = "src/auth/login.ts#handleLogin";
const events = realRun as PremiseEvent[];

const intent = (fields: Partial<IntentView> = {}): IntentView => ({ id: "i00000001", kind: "agent", taskId: "t02-audit-expired", goal: "Audit expired sessions.", status: "working", claims: [], premises: [], why: [], baseCommit: "a".repeat(40), headCommit: null, rederiveAttempts: 0, ...fields });
const premise = (symbol: string, source: Premise["source"], state: Premise["state"] = "holding"): Premise => ({ symbol, source, surfaceHash: "abcdef0123456789", state, ...(state === "broken" ? { brokenBy: { intentId: "i9", commit: "c".repeat(40), reason: "it changed" } } : {}) });

describe("names", () => {
	it("callsign is the task number and one word; anything else falls back to the id", () => {
		expect(callsign({ taskId: "t02-audit-expired", id: "i1" })).toBe("T02 AUDIT");
		expect(callsign({ taskId: "t11-expired-rate-limit", id: "i1" })).toBe("T11 EXPIRED");
		expect(callsign({ taskId: "workload", id: "iabc12345" })).toBe("IABC12345");
	});

	it("symbol parts and short shas", () => {
		expect([symbolName(VERIFY), symbolFile(VERIFY)]).toEqual(["verifySession", "session.ts"]);
		expect([shortSha("0123456789abcdef"), shortSha(null)]).toEqual(["0123456", "none"]);
	});
});

describe("status looks", () => {
	it("every status has a band, an icon and a word, so state is never colour alone", () => {
		for (const look of Object.values(STATUS_LOOK)) {
			expect(look.word.length).toBeGreaterThan(3);
			expect(look.icon).toBeTruthy();
		}
		expect(STATUS_LOOK.stale).toMatchObject({ band: "redpen", word: "stale" });
		expect(STATUS_LOOK.rederiving.band).toBe("bluestamp");
		expect(STATUS_LOOK.landed.band).toBe("holds");
		expect(STATUS_LOOK.waiting.band).toBe("amber");
		expect(STATUS_LOOK.escalated).toMatchObject({ band: "redpen", icon: "bell", word: "needs you" });
	});
});

describe("bays", () => {
	it("an Intent reaches Check when it has pushed, Gate when it is queued, Trunk when it lands", () => {
		expect(baysReached(intent({ status: "working" }))).toEqual({ check: false, gate: false, trunk: false });
		expect(baysReached(intent({ status: "checking" }))).toEqual({ check: true, gate: false, trunk: false });
		expect(baysReached(intent({ status: "quarantined" }))).toEqual({ check: true, gate: false, trunk: false });
		expect(baysReached(intent({ status: "gating" }))).toEqual({ check: true, gate: true, trunk: false });
		expect(baysReached(intent({ status: "landed" }))).toEqual({ check: true, gate: true, trunk: true });
	});

	it("an Intent the gate turned back keeps the bays it reached while it is re-derived", () => {
		const report = { intentId: "i1", path: "rebase" as const, textConflict: false, typecheck: { ok: true, errors: [] }, tests: { passed: [], failed: [] }, assertions: { passed: [], failed: [] }, ok: false, landedCommit: null, durationMs: 1 };
		expect(baysReached(intent({ status: "rederiving", gate: report }))).toEqual({ check: true, gate: true, trunk: false });
	});
});

describe("annotation", () => {
	const names = (id: string) => (id === "i5" ? "T05 TAX" : id);

	it("is the red-pen note for a broken premise, short enough to read at a glance", () => {
		const broken = [premise(VERIFY, "asserted", "broken")];
		expect(annotation(intent({ status: "stale", premises: broken }), names)).toBe("verifySession changed");
		expect(annotation(intent({ status: "rederiving", premises: broken }), names)).toBe("verifySession changed: re-deriving");
		expect(annotation(intent({ status: "escalated", premises: broken }), names)).toBe("verifySession changed: needs you");
		// Once it has landed there is nothing left to say.
		expect(annotation(intent({ status: "landed", premises: broken }), names)).toBeUndefined();
	});

	it("says who a waiting Intent is waiting on", () => {
		expect(annotation(intent({ status: "waiting", decision: { kind: "wait", on: "i5", symbols: [] } }), names)).toBe("waiting on T05");
		expect(waitingOn(intent({ status: "working", decision: { kind: "wait", on: "i5", symbols: [] } }))).toBeUndefined();
		expect(annotation(intent(), names)).toBeUndefined();
	});
});

describe("chipsFor", () => {
	it("lists what it changes, then what it relies on: asserted first, then broken, called, read", () => {
		const chips = chipsFor(intent({ claims: [{ symbol: LOGIN, mode: "body" }], premises: [premise("a#read", "observed"), premise("a#called", "derived"), premise("a#said", "asserted"), premise("a#gone", "observed", "broken")] }));
		expect(chips.map((chip) => [chip.kind, symbolName(chip.symbol), chip.detail, chip.broken])).toEqual([
			["changes", "handleLogin", "body", false],
			["relies", "said", "asserted", false],
			["relies", "gone", "observed", true],
			["relies", "called", "derived", false],
			["relies", "read", "observed", false],
		]);
		expect(chips[2]).toMatchObject({ reason: "it changed", hash: "abcdef0123456789" });
	});

	it("shows a symbol once: not as relied on if it is being changed, and under its strongest source", () => {
		const chips = chipsFor(intent({ claims: [{ symbol: LOGIN, mode: "interface" }], premises: [premise(LOGIN, "observed"), premise(VERIFY, "observed"), premise(VERIFY, "asserted")] }));
		expect(chips.map((chip) => [symbolName(chip.symbol), chip.detail])).toEqual([["handleLogin", "interface"], ["verifySession", "asserted"]]);
	});

	it("drops broken premises once the Intent has landed: the work on trunk no longer relies on them", () => {
		const premises = [premise(VERIFY, "asserted", "broken"), premise("a#read", "observed")];
		expect(chipsFor(intent({ status: "rederiving", premises })).some((chip) => chip.broken)).toBe(true);
		expect(chipsFor(intent({ status: "landed", premises })).map((chip) => symbolName(chip.symbol))).toEqual(["read"]);
	});

	it("touches says whether an Intent changes or relies on a symbol", () => {
		const subject = intent({ claims: [{ symbol: LOGIN, mode: "body" }], premises: [premise(VERIFY, "observed")] });
		expect([touches(subject, LOGIN), touches(subject, VERIFY), touches(subject, "x#y")]).toEqual([true, true, false]);
	});
});

describe("the recorded run", () => {
	// A real run of the deployed system: 12 scripted agents with t01 landing first, plus a scripted workload.
	const at = (count: number) => reduceAll(events.slice(0, count));
	const firstBreak = events.findIndex((event) => event.t === "premise.broken");
	const whenBroken = at(firstBreak + 20);
	const end = at(events.length);

	it("has one strip per agent, in task order, and one summary for the workload", () => {
		const lanes = lanesOf(end);
		expect(lanes.agents.map((agent) => callsign(agent).split(" ")[0])).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12"]);
		expect(lanes.agents.every((agent) => agent.status === "landed")).toBe(true);
		expect(lanes.workload).toMatchObject({ moving: 0, stale: 0 });
		expect((lanes.workload?.landed ?? 0) + (lanes.workload?.failed ?? 0)).toBe(lanes.workload?.total);
		expect(lanesOf(at(5)).workload).toBeNull();
	});

	it("at the premise break, t01 has landed and the three that relied on it are red, with the note", () => {
		const byCall = Object.fromEntries(lanesOf(whenBroken).agents.map((agent) => [callsign(agent).split(" ")[0], agent]));
		expect(byCall.T01?.status).toBe("landed");
		for (const call of ["T02", "T03", "T11"]) {
			const agent = byCall[call] as IntentView;
			expect(["stale", "rederiving"]).toContain(agent.status);
			expect(annotation(agent, (id) => id)).toMatch(/^verifySession changed/);
			expect(chipsFor(agent).find((chip) => chip.broken)).toMatchObject({ symbol: VERIFY, kind: "relies", detail: "asserted" });
		}
		// The control read the same file and is untouched.
		expect(["stale", "rederiving"]).not.toContain(byCall.T04?.status);
		expect(chipsFor(byCall.T04 as IntentView).some((chip) => chip.broken)).toBe(false);
	});

	it("the ledger puts the broken symbol first, with the readers whose premise broke", () => {
		const rows = ledgerRows(whenBroken);
		expect(rows[0]).toMatchObject({ symbol: VERIFY });
		expect(rows[0]?.broken).toHaveLength(3);
		expect(rows.some((row) => row.contested)).toBe(true);
		// Only agents' Intents are listed, and nothing is left once everything has landed.
		expect(ledgerRows(end)).toEqual([]);
	});

	it("re-derived Intents carry their stamp count to the end", () => {
		const stamped = lanesOf(end).agents.filter((agent) => (agent.races ?? 0) > 0).map((agent) => callsign(agent).split(" ")[0]);
		expect(stamped).toEqual(["T02", "T03", "T11"]);
	});
});

describe("layoutFor", () => {
	it("is wide from 1280, medium from 768, and a phone below that", () => {
		expect([1920, 1440, 1280].map(layoutFor)).toEqual(["wide", "wide", "wide"]);
		expect([1279, 1024, 768].map(layoutFor)).toEqual(["medium", "medium", "medium"]);
		expect([767, 430, 375, 320].map(layoutFor)).toEqual(["phone", "phone", "phone", "phone"]);
	});
});
