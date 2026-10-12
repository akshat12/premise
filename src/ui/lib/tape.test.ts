import { describe, expect, it } from "vitest";
import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import recording from "../fixtures/run-2026-10-09.json";
import { reduceAll } from "./reduce";
import { buildTape, clock, positionAt, spanFor, ticksFor, advanceTape } from "./tape";

const run = recording as PremiseEvent[];
const tapeAt = (count: number) => {
	const events = run.slice(0, count);
	return buildTape(events, reduceAll(events).intents);
};
const seconds = (ms: number) => Math.round(ms / 100) / 10;

describe("clock, spanFor and ticksFor", () => {
	it("writes times as minutes and seconds", () => {
		expect([0, 999, 57_000, 275_400].map(clock)).toEqual(["0:00", "0:00", "0:57", "4:35"]);
	});

	it("shows a minute at first, then grows in steps so now is never past 95% of the axis", () => {
		expect([0, 20_000, 57_000].map(spanFor)).toEqual([60_000, 60_000, 60_000]);
		expect([58_000, 85_000, 86_000, 114_000, 171_000, 275_000, 286_000].map(spanFor)).toEqual([90_000, 90_000, 120_000, 120_000, 180_000, 300_000, 600_000]);
		// Past ten minutes: whole steps of five.
		expect(spanFor(571_000)).toBe(900_000);
		expect(spanFor(3_600_000)).toBe(3_900_000);
	});

	it("marks every 10 s on a short axis, every 30 s up to five minutes, and never more than about ten marks", () => {
		expect(ticksFor(60_000)).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);
		expect(ticksFor(90_000).length).toBe(9);
		expect(ticksFor(300_000)).toEqual([0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000, 240_000, 270_000]);
		expect(ticksFor(600_000).length).toBe(10);
		expect(ticksFor(3_900_000).length).toBeLessThanOrEqual(10);
	});
});

describe("buildTape, on the recorded run", () => {
	// Event 3734 is the moment T02's re-derive wins its race, 57 s in.
	const tape = tapeAt(3734);
	const row = (name: string) => {
		const found = tape.rows.find((candidate) => candidate.callsign === name);
		if (!found) {
			throw new Error(`no row ${name}`);
		}
		return found;
	};

	it("has one row for each agent's Intent, in task order, and none for the workload", () => {
		expect(tape.rows.map((r) => r.callsign)).toEqual(["T01 NULL", "T02 AUDIT", "T03 EXPIRED", "T04 SESSION", "T05 TAX", "T06 DISCOUNT", "T07 ROLE", "T08 PROFILE", "T09 CURRENCY", "T10 INVOICE", "T11 EXPIRED", "T12 PASSWORD"]);
	});

	it("draws one break, where T01 landed, with a short flag and a full sentence", () => {
		expect(tape.breaks).toHaveLength(1);
		const line = tape.breaks[0];
		expect(line).toMatchObject({ n: 1, flag: "T01 landed · verifySession changed" });
		expect(line?.sentence).toBe("0:25 · T01 NULL landed and changed verifySession. T02 AUDIT, T03 EXPIRED and T11 EXPIRED relied on it and went stale.");
		expect(seconds(line?.at ?? 0)).toBeCloseTo(25.4, 0);
	});

	it("shows T02 working, at the gate, stopped by T01's landing, re-derived and landed", () => {
		const t02 = row("T02 AUDIT");
		const line = tape.breaks[0]?.at ?? 0;
		expect(t02.segments.map((s) => [s.kind, s.label])).toEqual([
			["work", ""],
			["gate", ""],
			["stale", "premise broke"],
			["rederive", "re-derived"],
		]);
		// Its fork was ready 3.1 s after dispatch: that is where the row begins.
		expect(seconds(t02.segments[0]?.from ?? 0)).toBe(3.1);
		// It went stale 0.7 s after T01 landed. It is drawn stopping at the landing itself, and so is the bar before it.
		expect(t02.segments[2]?.from).toBe(line);
		expect(t02.segments[1]?.to).toBe(line);
		expect(t02.hits).toEqual([line]);
		expect(t02.segments[2]?.tip).toBe("Premise broke at 0:26: T01 landed · verifySession changed");
		expect(t02.segments[3]).toMatchObject({ rebased: false, open: false });
		expect(t02.segments[3]?.tip).toMatch(/^The plain rebase was turned away at the gate\. The re-derive passed the gate, 0:31 to 0:56$/);
		expect(t02.end).toMatchObject({ kind: "landed" });
		expect(t02.end?.sha).toMatch(/^b0a5396/);
		expect(t02.races).toBe(1);
		expect(t02.summary).toBe('T02 AUDIT, Write an audit log entry with event "session.expired" whenever a login request (handleLogin in src/auth/login.ts) arrives with an expired session. Landed at 0:56. Premise broke at 0:26 when T01 landed and verifySession changed. Re-derived.');
	});

	it("shows a re-derive that is still going as open, up to now", () => {
		const t03 = row("T03 EXPIRED");
		expect(t03.segments.at(-1)).toMatchObject({ kind: "rederive", open: true, label: "re-deriving", to: tape.now });
		expect(t03.end).toBeUndefined();
		expect(t03.summary).toMatch(/Re-deriving now\. Premise broke at 0:26 when T01 landed and verifySession changed\.$/);
	});

	it("draws nothing of a stopped Intent past the line, even one that reached the gate just after the landing", () => {
		// T11 pushed half a second after T01 landed, and was told a moment later.
		const line = tape.breaks[0]?.at ?? 0;
		const t11 = row("T11 EXPIRED");
		const before = t11.segments.slice(0, t11.segments.findIndex((s) => s.kind === "stale"));
		expect(before.length).toBeGreaterThan(0);
		expect(before.every((s) => s.to <= line && s.from <= s.to)).toBe(true);
		expect(t11.segments.find((s) => s.kind === "stale")?.from).toBe(line);
	});

	it("leaves an Intent the landing did not touch without a hit", () => {
		expect(row("T04 SESSION").hits).toEqual([]);
		expect(row("T05 TAX").hits).toEqual([]);
	});

	it("shows T05's quarantine as a wait on the Intent that held the symbol", () => {
		const wait = row("T05 TAX").segments.find((s) => s.kind === "wait");
		expect(wait).toMatchObject({ label: "quarantined · waiting on T06", open: false });
		expect(wait?.tip).toBe("Quarantined: it edited a symbol it had not claimed, held until T06 DISCOUNT lands, 0:20 to 0:51");
		expect(row("T05 TAX").segments.at(-1)).toMatchObject({ kind: "gate", open: true, label: "at the gate" });
	});

	it("shows that a person was asked about T05, and that nobody had to answer", () => {
		// At the premise break (event 2205) T05 is still quarantined and its card is open.
		const during = tapeAt(2205).rows.find((r) => r.callsign === "T05 TAX");
		expect(during?.asks).toEqual([{ at: during?.asks[0]?.at, open: true, tip: "Asked a person at 0:20: Wait, Split or Depend. Nobody has answered yet." }]);
		expect(seconds(during?.asks[0]?.at ?? 0)).toBe(20.3);
		// By 0:57 T06 has landed, T05 was checked again and went on by itself.
		const after = row("T05 TAX");
		expect(after.asks).toEqual([{ at: during?.asks[0]?.at, open: false, tip: "Asked a person at 0:20: Wait, Split or Depend. Nobody had to choose: it moved on by itself." }]);
		expect(after.summary).toContain("A person was asked at 0:20: Wait, Split or Depend. Nobody had to choose: it moved on by itself.");
		expect(row("T02 AUDIT").asks).toEqual([]);
	});

	it("puts every landing on trunk, agents' and the workload's", () => {
		expect(tape.landings.filter((landing) => landing.agent).map((landing) => landing.tip)).toEqual([
			"T01 NULL landed at 0:25 (16368bb)",
			"T04 SESSION landed at 0:46 (a42a092)",
			"T06 DISCOUNT landed at 0:48 (72ec225)",
			"T07 ROLE landed at 0:53 (a0eba9b)",
			"T02 AUDIT landed at 0:56 (b0a5396)",
		]);
		expect(tape.landings).toHaveLength(15);
	});

	it("counts the workload's landings in 5 s buckets along the same axis, and marks where its Intents went stale", () => {
		expect(tape.workload?.bucketMs).toBe(5000);
		expect(tape.workload?.landed).toHaveLength(tape.span / 5000);
		expect(tape.workload?.landed.reduce((sum, count) => sum + count, 0)).toBe(10);
		expect(tape.workload?.stale.some(Boolean)).toBe(true);
	});

	it("keeps now inside the axis", () => {
		expect(tape.span).toBe(60_000);
		expect(seconds(tape.now)).toBeCloseTo(56.6, 0);
	});
});

describe("buildTape, at other moments of the run", () => {
	it("follows the whole run: by the end the axis is five minutes and every agent has landed", () => {
		const done = tapeAt(run.length);
		expect(done.span).toBe(300_000);
		expect(done.rows.every((r) => r.end?.kind === "landed")).toBe(true);
		expect(done.landings).toHaveLength(264);
		expect(done.workload?.landed.reduce((sum, count) => sum + count, 0)).toBe(252);
		// Six stretches of idle time were cut out of this recording, and each is marked.
		expect(done.cuts).toHaveLength(6);
		expect(done.cuts[0]?.label).toBe("5s of idle time cut here");
		// Still only one break is flagged for the agents: the workload's own breaks stay in its row.
		expect(done.breaks).toHaveLength(1);
	});

	it("is empty for an empty log", () => {
		expect(buildTape([], {})).toEqual({ rows: [], landings: [], breaks: [], cuts: [], workload: null, now: 0, span: 60_000, ticks: ticksFor(60_000) });
	});
});

describe("buildTape, cases the recording does not have", () => {
	const numbered = (bodies: (PremiseEventBody & { at: number })[]): PremiseEvent[] => bodies.map(({ at, ...body }, index) => ({ ...(body as PremiseEventBody), seq: index + 1, ts: 1_000_000 + at }));
	const created = (id: string, taskId: string, at: number, kind: "agent" | "workload" = "agent") =>
		({ t: "intent.created", at, intent: { id, kind, taskId, goal: "Do the thing. And more.", status: "planning", claims: [], premises: [], why: [], baseCommit: "c0", headCommit: null, rederiveAttempts: 0 } }) satisfies PremiseEventBody & { at: number };
	const status = (id: string, s: "working" | "queued" | "stale" | "rederiving" | "escalated" | "failed" | "landed" | "waiting", at: number) => ({ t: "intent.status", id, status: s, at }) satisfies PremiseEventBody & { at: number };
	const build = (events: PremiseEvent[]) => buildTape(events, reduceAll(events).intents);

	it("marks a wait that only a person can end, and an Intent that failed", () => {
		const tape = build(numbered([created("i00000001", "t01-alpha", 0), status("i00000001", "working", 1000), status("i00000001", "escalated", 5000), created("i00000002", "t02-beta", 0), status("i00000002", "failed", 8000)]));
		expect(tape.rows[0]?.segments.at(-1)).toMatchObject({ kind: "person", label: "needs you", open: true });
		expect(tape.rows[0]?.summary).toBe("T01 ALPHA, Do the thing. Needs you now. Needs you since 0:05.");
		expect(tape.rows[1]?.end).toEqual({ at: 8000, kind: "failed", sha: null });
		expect(tape.rows[1]?.summary).toBe("T02 BETA, Do the thing. Failed at 0:08.");
	});

	it("says 'rebased' when the plain rebase won the race, and shows a second stale stretch after a failed one", () => {
		const tape = build(
			numbered([
				created("i00000001", "t01-alpha", 0),
				status("i00000001", "stale", 10_000),
				status("i00000001", "rederiving", 12_000),
				{ t: "rederive.race", id: "i00000001", rebase: "fail", rederive: "fail", at: 20_000 },
				status("i00000001", "stale", 20_000),
				status("i00000001", "rederiving", 22_000),
				{ t: "rederive.race", id: "i00000001", rebase: "pass", rederive: "pending", winner: "rebase", at: 30_000 },
				status("i00000001", "landed", 30_000),
			]),
		);
		expect(tape.rows[0]?.segments.map((s) => [s.kind, s.label, s.rebased])).toEqual([
			["work", "", false],
			["stale", "premise broke", false],
			["rederive", "did not pass", false],
			["stale", "premise broke", false],
			["rederive", "rebased", true],
		]);
	});

	it("numbers every break in time order, and counts the other symbols a landing changed", () => {
		const tape = build(
			numbered([
				created("i00000001", "t01-alpha", 0),
				created("i00000002", "t02-beta", 0),
				created("i00000003", "t03-gamma", 0),
				status("i00000001", "landed", 30_000),
				{ t: "trunk.advanced", commit: "c1", byIntent: "i00000001", changedSymbols: [], at: 30_000 },
				{ t: "premise.broken", id: "i00000003", symbol: "src/a.ts#f", byIntent: "i00000001", commit: "c1", reason: "r", at: 30_100 },
				status("i00000002", "landed", 31_000),
				{ t: "trunk.advanced", commit: "c2", byIntent: "i00000002", changedSymbols: [], at: 31_000 },
				{ t: "premise.broken", id: "i00000003", symbol: "src/a.ts#g", byIntent: "i00000002", commit: "c2", reason: "r", at: 31_100 },
				{ t: "premise.broken", id: "i00000003", symbol: "src/a.ts#h", byIntent: "i00000002", commit: "c2", reason: "r", at: 31_100 },
			]),
		);
		expect(tape.breaks.map((line) => [line.n, line.flag])).toEqual([
			[1, "T01 landed · f changed"],
			[2, "T02 landed · g +1 changed"],
		]);
		expect(tape.breaks[1]?.sentence).toBe("0:31 · T02 BETA landed and changed g and h. T03 GAMMA relied on them and went stale.");
	});

	it("records an answer when a person gave one", () => {
		const tape = build(
			numbered([
				created("i00000001", "t01-alpha", 0),
				status("i00000001", "waiting", 4000),
				{ t: "human.needed", id: "i00000001", kind: "stalemate", message: "m", options: ["Wait", "Split", "Depend"], at: 5000 },
				{ t: "human.resolved", id: "i00000001", choice: "Split", at: 9000 },
				status("i00000001", "working", 9100),
			]),
		);
		expect(tape.rows[0]?.asks).toEqual([{ at: 5000, open: false, tip: "Asked a person at 0:05: Wait, Split or Depend. The answer was Split, at 0:09." }]);
	});

	it("marks a row the landing stopped even when it went stale some seconds later, without moving its bars", () => {
		const tape = build(
			numbered([
				created("i00000001", "t01-alpha", 0),
				created("i00000002", "t02-beta", 0),
				status("i00000001", "landed", 10_000),
				{ t: "trunk.advanced", commit: "c1", byIntent: "i00000001", changedSymbols: [], at: 10_000 },
				{ t: "premise.broken", id: "i00000002", symbol: "src/a.ts#f", byIntent: "i00000001", commit: "c1", reason: "r", at: 16_000 },
				status("i00000002", "stale", 16_000),
			]),
		);
		const late = tape.rows[1];
		expect(late?.hits).toEqual([10_000]);
		// Six seconds is too far to pretend it stopped at the line: the bars keep their true times.
		expect(late?.segments.map((s) => [s.kind, s.from, s.to])).toEqual([
			["work", 0, 16_000],
			["stale", 16_000, 16_000],
		]);
	});

	it("says so when the change came from the workload or from outside the gate", () => {
		const tape = build(
			numbered([
				created("i00000001", "t01-alpha", 0),
				created("i0000000w", "workload", 0, "workload"),
				{ t: "premise.broken", id: "i00000001", symbol: "src/a.ts#f", byIntent: "i0000000w", commit: "c1", reason: "r", at: 10_000 },
				{ t: "premise.broken", id: "i00000001", symbol: "src/a.ts#g", byIntent: "outside-the-gate", commit: "c2", reason: "r", at: 40_000 },
			]),
		);
		expect(tape.breaks.map((line) => line.flag)).toEqual(["Workload landed · f changed", "Pushed to trunk outside the gate · g changed"]);
		expect(tape.breaks[1]?.sentence).toBe("0:40 · A push to trunk from outside the gate changed g. T01 ALPHA relied on it and went stale.");
	});
});

describe("positionAt", () => {
	it("says how many events have happened by a moment, for moving a replay there", () => {
		expect(positionAt(run, 0)).toBeGreaterThanOrEqual(1);
		const at = positionAt(run, 26_000);
		expect((run[at - 1]?.ts ?? 0) - (run[0]?.ts ?? 0)).toBeLessThanOrEqual(26_000);
		expect((run[at]?.ts ?? 0) - (run[0]?.ts ?? 0)).toBeGreaterThan(26_000);
		expect(positionAt(run, 10_000_000)).toBe(run.length);
		expect(positionAt([], 5000)).toBe(1);
	});
});

describe("advanceTape", () => {
	const run = recording as PremiseEvent[];
	const upTo = (count: number) => run.slice(0, count);
	const tapeAt = (count: number) => buildTape(upTo(count), reduceAll(upTo(count)).intents, 300_000);

	it("moves now on and grows only the bars that are still open", () => {
		const tape = tapeAt(900);
		const later = advanceTape(tape, tape.now + 2000);
		expect(later.now).toBe(tape.now + 2000);
		const open = tape.rows.flatMap((row) => row.segments).filter((segment) => segment.open);
		expect(open.length).toBeGreaterThan(0);
		for (const [index, row] of tape.rows.entries()) {
			for (const [at, segment] of row.segments.entries()) {
				const after = later.rows[index]?.segments[at];
				expect(after?.from).toBe(segment.from);
				expect(after?.to).toBe(segment.open ? tape.now + 2000 : segment.to);
			}
		}
	});

	it("never moves time backwards and never runs off the axis", () => {
		const tape = tapeAt(900);
		expect(advanceTape(tape, tape.now - 500)).toBe(tape);
		expect(advanceTape(tape, 10 * tape.span).now).toBe(tape.span);
	});

	it("keeps one axis for the whole run when the run's length is given", () => {
		expect(tapeAt(50).span).toBe(tapeAt(900).span);
		expect(tapeAt(50).span).toBe(tapeAt(run.length).span);
	});
});
