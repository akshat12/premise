import { describe, expect, it } from "vitest";
import type { IntentSummary, PremiseEvent, PremiseEventBody } from "../../shared/events";
import { EVENT_TYPES } from "../../shared/wire";
import type { GateReport, Metrics, Premise } from "../../shared/types";
import sampleRun from "../fixtures/sample-run.json";
import { initialViewState, reduce, reduceAll, type ViewState } from "./reduce";

const VERIFY = "src/auth/session.ts#verifySession";
const LOGIN = "src/auth/login.ts#handleLogin";
const SHA = (char: string) => char.repeat(40);

function summary(id: string, overrides: Partial<IntentSummary> = {}): IntentSummary {
	return { id, kind: "agent", taskId: "t02-audit-expired", goal: "goal", status: "planning", claims: [], premises: [], why: [], baseCommit: SHA("0"), headCommit: null, rederiveAttempts: 0, ...overrides };
}

const observed = (symbol: string): Premise => ({ symbol, source: "observed", surfaceHash: "h1", state: "holding" });
const asserted = (symbol: string): Premise => ({
	symbol,
	source: "asserted",
	surfaceHash: null,
	state: "holding",
	assertion: { id: "a1", description: "throws", code: "assert.ok(true)", imports: [] },
});

let seq = 0;
function run(bodies: PremiseEventBody[], from: ViewState = initialViewState()): ViewState {
	return reduceAll(bodies.map((body): PremiseEvent => ({ ...body, seq: ++seq, ts: seq * 10 })), from);
}

const created = (id: string, overrides: Partial<IntentSummary> = {}): PremiseEventBody => ({ t: "intent.created", intent: summary(id, overrides) });

const report = (intentId: string, overrides: Partial<GateReport> = {}): GateReport => ({
	intentId,
	path: "rebase",
	textConflict: false,
	typecheck: { ok: true, errors: [] },
	tests: { passed: ["ac1"], failed: [] },
	assertions: { passed: [], failed: [] },
	ok: true,
	landedCommit: SHA("c"),
	durationMs: 10,
	...overrides,
});

describe("reduce: one case per event type", () => {
	it("intent.created adds the Intent and its ledger entries", () => {
		const state = run([created("i1", { claims: [{ symbol: LOGIN, mode: "body" }], premises: [observed(VERIFY)] })]);
		expect(state.intents.i1).toMatchObject({ id: "i1", status: "planning" });
		expect(state.ledger).toEqual({ [LOGIN]: { writer: "i1", readers: [] }, [VERIFY]: { readers: ["i1"] } });
	});

	it("intent.status updates status and keeps the last note", () => {
		const state = run([created("i1"), { t: "intent.status", id: "i1", status: "waiting", note: "Waiting on i2" }, { t: "intent.status", id: "i1", status: "working" }]);
		expect(state.intents.i1).toMatchObject({ status: "working", lastNote: "Waiting on i2" });
	});

	it("intent.status landed records the landing and frees the ledger", () => {
		const state = run([
			created("i1", { claims: [{ symbol: LOGIN, mode: "body" }], premises: [observed(VERIFY)] }),
			created("i2", { premises: [observed(VERIFY)] }),
			{ t: "intent.status", id: "i1", status: "landed" },
			{ t: "intent.status", id: "i1", status: "landed" },
		]);
		expect(state.trunk.landed).toEqual(["i1"]);
		expect(state.ledger).toEqual({ [VERIFY]: { readers: ["i2"] } });
		// The card keeps its own chips after landing.
		expect(state.intents.i1?.claims).toHaveLength(1);
	});

	it("intent.status failed frees the ledger without landing", () => {
		const state = run([created("i1", { claims: [{ symbol: LOGIN, mode: "body" }] }), { t: "intent.status", id: "i1", status: "failed" }]);
		expect(state.ledger).toEqual({});
		expect(state.trunk.landed).toEqual([]);
	});

	it("intent.why replaces the why lines", () => {
		const state = run([created("i1"), { t: "intent.why", id: "i1", why: ["a", "b"] }]);
		expect(state.intents.i1?.why).toEqual(["a", "b"]);
	});

	it("premise.recorded adds a premise, replaces a repeat, and keeps observed and asserted apart", () => {
		const state = run([
			created("i1"),
			{ t: "premise.recorded", id: "i1", premise: observed(VERIFY) },
			{ t: "premise.recorded", id: "i1", premise: { ...observed(VERIFY), surfaceHash: "h2" } },
			{ t: "premise.recorded", id: "i1", premise: asserted(VERIFY) },
		]);
		expect(state.intents.i1?.premises.map((p) => [p.source, p.surfaceHash])).toEqual([
			["observed", "h2"],
			["asserted", null],
		]);
		expect(state.ledger[VERIFY]).toEqual({ readers: ["i1"] });
	});

	it("premise.broken turns matching premises red with the cause", () => {
		const state = run([
			created("i1", { premises: [asserted(VERIFY), observed(LOGIN)] }),
			{ t: "premise.broken", id: "i1", symbol: VERIFY, byIntent: "i9", commit: SHA("a"), reason: "no longer throws" },
		]);
		const [broken, holding] = state.intents.i1?.premises ?? [];
		expect(broken).toMatchObject({ state: "broken", brokenBy: { intentId: "i9", commit: SHA("a"), reason: "no longer throws" } });
		expect(holding).toMatchObject({ symbol: LOGIN, state: "holding" });
		expect(state.intents.i1?.lastNote).toBe("no longer throws");
	});

	it("claim.decision granted adds claims and makes the Intent the writer", () => {
		const state = run([created("i1", { claims: [{ symbol: LOGIN, mode: "interface" }] }), { t: "claim.decision", id: "i1", decision: { kind: "granted" }, symbols: [LOGIN, VERIFY] }]);
		expect(state.intents.i1?.claims).toEqual([
			{ symbol: LOGIN, mode: "interface" },
			{ symbol: VERIFY, mode: "body" },
		]);
		expect(state.ledger[VERIFY]?.writer).toBe("i1");
		expect(state.intents.i1?.decision).toEqual({ kind: "granted" });
	});

	it("claim.decision wait, split and depend are recorded without granting anything", () => {
		const decisions = [
			{ kind: "wait", on: "i2", symbols: [LOGIN] },
			{ kind: "depend", on: "i2", symbols: [LOGIN] },
			{ kind: "split", with: "i2", proposal: { mine: [VERIFY], theirs: [LOGIN] } },
		] as const;
		for (const decision of decisions) {
			const state = run([created("i1"), { t: "claim.decision", id: "i1", decision: structuredClone(decision) as never, symbols: [LOGIN] }]);
			expect(state.intents.i1?.decision?.kind).toBe(decision.kind);
			expect(state.intents.i1?.claims).toEqual([]);
			expect(state.ledger).toEqual({});
		}
	});

	it("push.checked records the head commit and any out-of-claim edits", () => {
		const state = run([created("i1"), { t: "push.checked", id: "i1", commit: SHA("b"), touched: [LOGIN, VERIFY], outOfClaim: [VERIFY] }]);
		expect(state.intents.i1).toMatchObject({ headCommit: SHA("b"), outOfClaim: [VERIFY] });
	});

	it("gate.result attaches the report to its Intent", () => {
		const failing = report("i1", { ok: false, landedCommit: null, assertions: { passed: [], failed: [{ id: "a1", error: "did not throw" }] } });
		const state = run([created("i1"), { t: "gate.result", report: failing }]);
		expect(state.intents.i1?.gate).toEqual(failing);
	});

	it("trunk.advanced moves trunk and records who landed", () => {
		const state = run([
			created("i1"),
			{ t: "trunk.advanced", commit: SHA("c"), byIntent: "i1", changedSymbols: [VERIFY] },
			{ t: "trunk.advanced", commit: SHA("d"), byIntent: null, changedSymbols: [] },
		]);
		expect(state.trunk).toEqual({ commit: SHA("d"), landed: ["i1"] });
	});

	it("rederive.race tracks both legs and the winner", () => {
		const pending = run([created("i1"), { t: "rederive.race", id: "i1", rebase: "pending", rederive: "pending" }]);
		expect(pending.intents.i1?.race).toEqual({ rebase: "pending", rederive: "pending" });
		const done = run([{ t: "rederive.race", id: "i1", rebase: "fail", rederive: "pass", winner: "rederive" }], pending);
		expect(done.intents.i1?.race).toEqual({ rebase: "fail", rederive: "pass", winner: "rederive" });
	});

	it("human.needed opens a card and human.resolved records the choice", () => {
		const open = run([created("i1"), { t: "human.needed", id: "i1", kind: "stalemate", message: "pick", options: ["Wait", "Split", "Depend"] }]);
		expect(open.intents.i1?.human).toEqual({ kind: "stalemate", message: "pick", options: ["Wait", "Split", "Depend"] });
		const closed = run([{ t: "human.resolved", id: "i1", choice: "Split" }], open);
		expect(closed.intents.i1?.human?.resolved).toBe("Split");
	});

	it("human.resolved without an open card changes nothing", () => {
		const before = run([created("i1")]);
		expect(run([{ t: "human.resolved", id: "i1", choice: "Split" }], before)).toEqual(before);
	});

	it("metrics replaces the counters", () => {
		const metrics: Metrics = { ...initialViewState().metrics, agentsActive: 12, intentsLanded: 7, rederives: { started: 3, succeeded: 3, failed: 0 } };
		expect(run([{ t: "metrics", metrics }]).metrics).toEqual(metrics);
	});

	it("artifacts leaves the view unchanged", () => {
		const before = run([created("i1")]);
		expect(run([{ t: "artifacts", type: "repo.forked", repo: "i1", detail: { source: "trunk" } }], before)).toBe(before);
	});

	it("demo.marker appends its label", () => {
		expect(run([{ t: "demo.marker", label: "⏩ 3 min compressed" }, { t: "demo.marker", label: "second" }]).markers).toEqual(["⏩ 3 min compressed", "second"]);
	});

	it("covers every event type in events.ts", () => {
		// Guards this file: if a type is added to events.ts, add a case above and to this list.
		const covered = ["intent.created", "intent.status", "intent.why", "premise.recorded", "premise.broken", "claim.decision", "push.checked", "gate.result", "trunk.advanced", "rederive.race", "human.needed", "human.resolved", "metrics", "artifacts", "demo.marker"];
		expect([...EVENT_TYPES].sort()).toEqual([...covered].sort());
	});
});

describe("reduce: robustness", () => {
	it("leaves the state unchanged for an unknown event type", () => {
		const before = run([created("i1")]);
		const unknown = { t: "from.the.future", seq: 999, ts: 1 } as unknown as PremiseEvent;
		expect(reduce(before, unknown)).toBe(before);
	});

	it("ignores events about an Intent it has never seen", () => {
		const before = initialViewState();
		const bodies: PremiseEventBody[] = [
			{ t: "intent.status", id: "ghost", status: "landed" },
			{ t: "intent.why", id: "ghost", why: ["x"] },
			{ t: "premise.recorded", id: "ghost", premise: observed(VERIFY) },
			{ t: "premise.broken", id: "ghost", symbol: VERIFY, byIntent: "i9", commit: SHA("a"), reason: "r" },
			{ t: "claim.decision", id: "ghost", decision: { kind: "granted" }, symbols: [VERIFY] },
			{ t: "push.checked", id: "ghost", commit: SHA("b"), touched: [], outOfClaim: [] },
			{ t: "gate.result", report: report("ghost") },
			{ t: "rederive.race", id: "ghost", rebase: "pending", rederive: "pending" },
			{ t: "human.needed", id: "ghost", kind: "fallback", message: "m", options: ["Retry", "Abandon"] },
			{ t: "human.resolved", id: "ghost", choice: "Retry" },
		];
		expect(run(bodies, before)).toEqual(before);
	});

	it("does not mutate the state it is given", () => {
		const before = run([created("i1", { premises: [observed(VERIFY)] })]);
		const frozen = structuredClone(before);
		run([{ t: "premise.broken", id: "i1", symbol: VERIFY, byIntent: "i9", commit: SHA("a"), reason: "r" }, { t: "intent.status", id: "i1", status: "landed" }], before);
		expect(before).toEqual(frozen);
	});
});

describe("sample-run fixture", () => {
	const events = sampleRun as PremiseEvent[];
	const state = reduceAll(events);

	it("is a well-formed log", () => {
		expect(events.length).toBeGreaterThanOrEqual(60);
		events.forEach((event, index) => {
			expect(event.seq).toBe(index + 1);
			expect(EVENT_TYPES).toContain(event.t);
			expect(event.ts).toBeGreaterThanOrEqual(events[index - 1]?.ts ?? 0);
		});
	});

	it("uses every event type at least once", () => {
		expect([...new Set(events.map((event) => event.t))].sort()).toEqual([...EVENT_TYPES].sort());
	});

	it("tells the demo story", () => {
		const ids = Object.keys(state.intents);
		expect(ids).toHaveLength(12);
		for (const id of ids) {
			expect(id).toMatch(/^i[0-9a-z]{8}$/);
		}

		// One landing changes verifySession, then exactly three premises break because of it.
		const advance = events.findIndex((event) => event.t === "trunk.advanced" && event.changedSymbols.includes(VERIFY));
		const broken = events.flatMap((event, index) => (event.t === "premise.broken" ? [{ event, index }] : []));
		expect(broken).toHaveLength(3);
		expect(broken.every(({ index, event }) => index > advance && event.symbol === VERIFY)).toBe(true);

		// Those three win by re-derive after the textual rebase fails, and then land.
		const rederived = Object.values(state.intents).filter((intent) => intent.race?.winner === "rederive");
		expect(rederived.map((intent) => intent.taskId).sort()).toEqual(["t02-audit-expired", "t03-expired-metrics", "t11-expired-rate-limit"]);
		for (const intent of rederived) {
			expect(intent.race).toEqual({ rebase: "fail", rederive: "pass", winner: "rederive" });
			expect(intent.status).toBe("landed");
			expect(intent.gate?.path).toBe("rederive");
		}

		// t04 also relies on verifySession, but only on its type surface, so its premise still holds.
		const control = Object.values(state.intents).find((intent) => intent.taskId === "t04-session-ttl-header");
		expect(control?.premises).toEqual([expect.objectContaining({ symbol: VERIFY, source: "observed", state: "holding" })]);
		expect(control?.status).toBe("landed");
	});

	it("ends with consistent counters", () => {
		expect(state.trunk.landed).toHaveLength(7);
		expect(state.metrics).toMatchObject({
			intentsLanded: 7,
			agentsActive: 5,
			premisesBroken: 3,
			brokenBuildsOnTrunk: 0,
			behaviouralRegressionsOnTrunk: 0,
			rederives: { started: 3, succeeded: 3, failed: 0 },
		});
		expect(state.markers).toEqual(["⏩ 2 min compressed"]);
		// The stalemate card was answered.
		const stalemate = Object.values(state.intents).find((intent) => intent.human);
		expect(stalemate?.human).toMatchObject({ kind: "stalemate", resolved: "Wait" });
	});
});
