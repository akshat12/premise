import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import realRun from "../fixtures/real-run.json";
import { type IntentView, reduceAll } from "./reduce";
import { callsign, lanesOf, layoutFor, shortSha, STATUS_LOOK, symbolFile, symbolName, waitingOn, clampDrawerHeight, DRAWER_MIN_HEIGHT, DRAWER_TOP_ROOM } from "./view";

const VERIFY = "src/auth/session.ts#verifySession";
const events = realRun as PremiseEvent[];

const intent = (fields: Partial<IntentView> = {}): IntentView => ({ id: "i00000001", kind: "agent", taskId: "t02-audit-expired", goal: "Audit expired sessions.", status: "working", claims: [], premises: [], why: [], baseCommit: "a".repeat(40), headCommit: null, rederiveAttempts: 0, ...fields });

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
		expect(STATUS_LOOK.stale).toMatchObject({ band: "redpen", word: "stopped" });
		expect(STATUS_LOOK.rederiving.band).toBe("bluestamp");
		expect(STATUS_LOOK.landed.band).toBe("holds");
		expect(STATUS_LOOK.waiting.band).toBe("amber");
		expect(STATUS_LOOK.escalated).toMatchObject({ band: "redpen", icon: "bell", word: "needs you" });
	});
});

describe("waitingOn", () => {
	it("names the Intent a waiting or quarantined one is held behind, and nothing for one that is working", () => {
		expect(waitingOn(intent({ status: "waiting", decision: { kind: "wait", on: "i5", symbols: [] } }))).toBe("i5");
		expect(waitingOn(intent({ status: "quarantined", decision: { kind: "split", with: "i6", proposal: { mine: [], theirs: [] } } }))).toBe("i6");
		expect(waitingOn(intent({ status: "working", decision: { kind: "wait", on: "i5", symbols: [] } }))).toBeUndefined();
	});
});

describe("the recorded run", () => {
	// A real run of the deployed system: 12 scripted agents with t01 landing first, plus a scripted workload.
	const at = (count: number) => reduceAll(events.slice(0, count));
	const firstBreak = events.findIndex((event) => event.t === "premise.broken");
	const whenBroken = at(firstBreak + 20);
	const end = at(events.length);

	it("has one row per agent, in task order, and one summary for the workload", () => {
		const lanes = lanesOf(end);
		expect(lanes.agents.map((agent) => callsign(agent).split(" ")[0])).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12"]);
		expect(lanes.agents.every((agent) => agent.status === "landed")).toBe(true);
		expect(lanes.workload).toMatchObject({ moving: 0, stale: 0 });
		expect((lanes.workload?.landed ?? 0) + (lanes.workload?.failed ?? 0)).toBe(lanes.workload?.total);
		expect(lanesOf(at(5)).workload).toBeNull();
	});

	it("at the premise break, t01 has landed and the three that relied on it are stopped, each with its asserted premise broken", () => {
		const byCall = Object.fromEntries(lanesOf(whenBroken).agents.map((agent) => [callsign(agent).split(" ")[0], agent]));
		expect(byCall.T01?.status).toBe("landed");
		for (const call of ["T02", "T03", "T11"]) {
			const agent = byCall[call] as IntentView;
			expect(["stale", "rederiving"]).toContain(agent.status);
			expect(agent.premises.some((held) => held.state === "broken" && held.symbol === VERIFY && held.source === "asserted")).toBe(true);
		}
		// The control read the same file and is untouched.
		expect(["stale", "rederiving"]).not.toContain(byCall.T04?.status);
		expect((byCall.T04 as IntentView).premises.some((held) => held.state === "broken")).toBe(false);
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

describe("clampDrawerHeight", () => {
	it("keeps a dragged drawer between its smallest size and what leaves the top of the page in view", () => {
		expect(clampDrawerHeight(400, 900)).toBe(400);
		expect(clampDrawerHeight(20, 900)).toBe(DRAWER_MIN_HEIGHT);
		expect(clampDrawerHeight(5000, 900)).toBe(900 - DRAWER_TOP_ROOM);
		expect(clampDrawerHeight(333.6, 900)).toBe(334);
	});

	it("never goes below the smallest size, even in a very short window", () => {
		expect(clampDrawerHeight(300, 200)).toBe(DRAWER_MIN_HEIGHT);
	});
});
