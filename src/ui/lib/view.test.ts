import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import realRun from "../fixtures/real-run.json";
import { type IntentView, reduceAll } from "./reduce";
import { callsign, lanesOf, layoutFor, shortSha, STATUS_LOOK, symbolFile, symbolName, waitingOn, clampDrawerHeight, columnEdges, dragColumns, DRAWER_COLUMN_MIN, DRAWER_COLUMNS, DRAWER_MIN_HEIGHT, DRAWER_TOP_ROOM, washOf } from "./view";

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
		expect(STATUS_LOOK.rederiving.band).toBe("redo");
		expect(STATUS_LOOK.landed.band).toBe("holds");
		// Waiting is not a colour: nothing is wrong, and the yellow belongs to work being redone.
		expect(STATUS_LOOK.waiting.band).toBe("ink-soft");
		expect(STATUS_LOOK.quarantined.band).toBe("ink-soft");
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

describe("dragColumns", () => {
	const sum = (weights: readonly number[]) => weights.reduce((total, weight) => total + weight, 0);
	const WIDTH = 1392;
	const px = (weights: readonly number[]) => weights.map((weight) => (weight / sum(weights)) * WIDTH);

	it("moves the divider by the pixels it was dragged, changing only the two columns beside it", () => {
		const before = px(DRAWER_COLUMNS);
		const after = px(dragColumns(DRAWER_COLUMNS, 1, 80, WIDTH));
		expect(after[0]).toBeCloseTo(before[0] as number, 6);
		expect(after[1]).toBeCloseTo((before[1] as number) + 80, 6);
		expect(after[2]).toBeCloseTo((before[2] as number) - 80, 6);
		expect(after[3]).toBeCloseTo(before[3] as number, 6);
		expect(sum(dragColumns(DRAWER_COLUMNS, 1, 80, WIDTH))).toBeCloseTo(sum(DRAWER_COLUMNS), 9);
	});

	it("stops at the narrowest a column may be, in either direction", () => {
		const farLeft = px(dragColumns(DRAWER_COLUMNS, 0, -5000, WIDTH));
		expect(farLeft[0]).toBeCloseTo(DRAWER_COLUMN_MIN, 6);
		const farRight = px(dragColumns(DRAWER_COLUMNS, 0, 5000, WIDTH));
		expect(farRight[1]).toBeCloseTo(DRAWER_COLUMN_MIN, 6);
		// The pair's width is the same as before, so the columns after it have not moved.
		expect((farRight[0] as number) + (farRight[1] as number)).toBeCloseTo((px(DRAWER_COLUMNS)[0] as number) + (px(DRAWER_COLUMNS)[1] as number), 6);
	});

	it("is measured from where the drag began, so dragging there and back changes nothing", () => {
		const out = dragColumns(DRAWER_COLUMNS, 2, 137, WIDTH);
		const back = dragColumns(out, 2, -137, WIDTH);
		back.forEach((weight, index) => expect(weight).toBeCloseTo(DRAWER_COLUMNS[index] as number, 9));
	});

	it("shares a pair evenly at most, where the row is too narrow for two columns of the smallest width", () => {
		// 200 pixels for two columns that each want 160: however far the divider is dragged, it stays in the middle.
		expect(dragColumns([1, 1], 0, 400, 200)).toEqual([1, 1]);
		expect(dragColumns([1, 1], 0, -400, 200)).toEqual([1, 1]);
	});

	it("leaves the columns alone for a divider that is not there, a row with no width, or a move that is not a number", () => {
		expect(dragColumns(DRAWER_COLUMNS, 3, 50, WIDTH)).toEqual([...DRAWER_COLUMNS]);
		expect(dragColumns(DRAWER_COLUMNS, -1, 50, WIDTH)).toEqual([...DRAWER_COLUMNS]);
		expect(dragColumns(DRAWER_COLUMNS, 0, 50, 0)).toEqual([...DRAWER_COLUMNS]);
		expect(dragColumns(DRAWER_COLUMNS, 0, Number.NaN, WIDTH)).toEqual([...DRAWER_COLUMNS]);
	});
});

describe("columnEdges", () => {
	it("gives each divider's place across the row, one for every column but the last", () => {
		expect(columnEdges([1, 1, 2])).toEqual([25, 50]);
		expect(columnEdges([1])).toEqual([]);
		expect(columnEdges([])).toEqual([]);
		const edges = columnEdges(DRAWER_COLUMNS);
		expect(edges).toHaveLength(3);
		expect(edges[2]).toBeCloseTo((3.4 / 5.4) * 100, 9);
	});
});

describe("washOf", () => {
	it("colours a lane green when its Intent has landed, red when it is stopped or needs a person, yellow while it is redone", () => {
		expect(washOf("landed")).toBe("landed");
		expect(washOf("stale")).toBe("stopped");
		expect(washOf("escalated")).toBe("stopped");
		expect(washOf("failed")).toBe("stopped");
		expect(washOf("rederiving")).toBe("redo");
	});

	it("leaves every other lane plain, waiting included", () => {
		for (const status of ["planning", "claiming", "waiting", "working", "submitted", "checking", "quarantined", "queued", "gating"] as const) {
			expect(washOf(status), status).toBeUndefined();
		}
	});
});
