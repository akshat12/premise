import { describe, expect, it } from "vitest";
import type { Assertion, Intent, IntentStatus, Premise } from "../../shared/types";
import type { BreakScope, BrokenBy } from "../intent/premises";
import type { Reader } from "../ledger/ledger-shard";
import type { RunRequest, RunResult } from "../runner";
import { assertionBreaks, assertionChecks, type InvalidateDeps, invalidateWith, type Landed, OUTSIDE_PUSH, surfaceBreaks } from "./invalidate";

const VERIFY = "src/auth/session.ts#verifySession";
const SESSION = "src/auth/session.ts#Session";
const TAX = "src/billing/tax.ts#taxFor";
const COMMIT = "c".repeat(40);

const assertion = (id: string, description = `premise ${id}`): Assertion => ({ id, description, code: "", imports: ["src/auth/session.ts"] });
const asserted = (id: string, symbol = VERIFY, state: Premise["state"] = "holding"): Premise => ({ symbol, source: "asserted", surfaceHash: null, state, assertion: assertion(id) });
const observed = (symbol: string): Premise => ({ symbol, source: "observed", surfaceHash: "h", state: "holding" });
const reader = (intentId: string, symbol: string): Reader => ({ intentId, symbol, surfaceHash: "h" });

interface World {
	statuses: Record<string, IntentStatus>;
	readers: Reader[];
	intents: Record<string, Pick<Intent, "id" | "premises">>;
	/** Run ids of the assertions that fail on the new trunk. */
	failing: string[];
	loadError?: string;
}

function fake(world: World) {
	const processed = new Set<string>();
	const breaks: { id: string; symbol: string; by: BrokenBy; scope: BreakScope }[] = [];
	const runs: RunRequest[] = [];
	let metrics = 0;
	const deps: InvalidateDeps = {
		claimCommit: async (commit) => !processed.has(commit) && processed.add(commit) !== undefined,
		registry: async () => Object.entries(world.statuses).map(([id, status]) => ({ id, status })),
		readersOf: async (symbols) => world.readers.filter((item) => symbols.includes(item.symbol)),
		asserters: async () => Object.values(world.intents).filter((intent) => intent.premises.some((premise) => premise.source === "asserted")).map((intent) => intent.id),
		getIntent: async (id) => world.intents[id] ?? null,
		async breakPremise(id, symbol, by, scope) {
			breaks.push({ id, symbol, by, scope });
			// As IntentDO does: an Intent that is at work goes stale; one still planning only has the premise marked.
			return { broken: true, stale: ["working", "submitted", "checking", "queued", "gating", "rederiving"].includes(world.statuses[id] ?? "") };
		},
		async run(req): Promise<RunResult> {
			runs.push(req);
			if (world.loadError !== undefined) {
				return { tests: [], assertions: req.assertions.map((item) => ({ id: item.id, ok: false, error: world.loadError, ms: 0 })), loadError: world.loadError };
			}
			return { tests: [], assertions: req.assertions.map((item) => ({ id: item.id, ok: !world.failing.includes(item.id), error: world.failing.includes(item.id) ? "it returned" : undefined, ms: 1 })) };
		},
		publishMetrics: async () => void metrics++,
	};
	return { deps, breaks, runs, metricsPublished: () => metrics };
}

const landed = (fields: Partial<Landed> = {}): Landed => ({ commit: COMMIT, byIntent: "ilander01", changedSymbols: [], newTrunkFiles: { "src/a.ts": "export const a = 1;\n" }, ...fields });

describe("invalidateWith", () => {
	it("a surface change breaks only the readers of the changed symbols", async () => {
		const world: World = {
			statuses: { ilander01: "landed", ireader01: "working", ireader02: "queued", iother001: "working" },
			readers: [reader("ireader01", SESSION), reader("ireader02", VERIFY), reader("iother001", TAX), reader("ilander01", SESSION)],
			intents: {},
			failing: [],
		};
		const h = fake(world);
		const result = await invalidateWith(h.deps, landed({ changedSymbols: [SESSION, VERIFY] }));

		expect(h.breaks.map((item) => [item.id, item.symbol])).toEqual([["ireader01", SESSION], ["ireader02", VERIFY]]);
		expect(h.breaks[0]).toMatchObject({ by: { intentId: "ilander01", commit: COMMIT, reason: "type surface of Session changed in intent ilander01" }, scope: { sources: ["observed", "derived"] } });
		expect(h.breaks[1]?.by.reason).toBe("type surface of verifySession changed in intent ilander01");
		expect(result).toMatchObject({ skipped: false, intents: ["ireader01", "ireader02"], stale: ["ireader01", "ireader02"] });
		expect(h.runs).toEqual([]); // nobody asserted anything
		expect(h.metricsPublished()).toBe(1);
	});

	it("an assertion that fails on the new trunk breaks only the Intent that made it", async () => {
		const world: World = {
			statuses: { ilander01: "landed", iasserts1: "working", iasserts2: "planning", iasserts3: "submitted" },
			readers: [],
			intents: {
				iasserts1: { id: "iasserts1", premises: [asserted("a1"), observed(VERIFY)] },
				iasserts2: { id: "iasserts2", premises: [asserted("a1", TAX)] },
				iasserts3: { id: "iasserts3", premises: [asserted("a1"), asserted("a2")] },
			},
			failing: ["iasserts1:a1", "iasserts3:a2"],
		};
		const h = fake(world);
		const result = await invalidateWith(h.deps, landed());

		// One isolate run for everybody, on the new trunk's files, with ids that cannot clash.
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0]?.files).toEqual({ "src/a.ts": "export const a = 1;\n" });
		expect(h.runs[0]?.tests).toEqual([]);
		expect(h.runs[0]?.assertions.map((item) => item.id)).toEqual(["iasserts1:a1", "iasserts2:a1", "iasserts3:a1", "iasserts3:a2"]);

		expect(h.breaks.map((item) => [item.id, item.symbol, item.scope])).toEqual([
			["iasserts1", VERIFY, { assertionId: "a1" }],
			["iasserts3", VERIFY, { assertionId: "a2" }],
		]);
		expect(h.breaks[0]?.by).toEqual({ intentId: "ilander01", commit: COMMIT, reason: "assertion 'premise a1' no longer holds after intent ilander01" });
		expect(result.intents).toEqual(["iasserts1", "iasserts3"]);
		expect(result.stale).toEqual(["iasserts1", "iasserts3"]);
	});

	it("never breaks an Intent that has landed or failed, is already stale, or is the one that landed", async () => {
		const world: World = {
			statuses: { ilander01: "landed", idone0001: "landed", igone0001: "failed", istale001: "stale", ilive0001: "checking" },
			readers: ["ilander01", "idone0001", "igone0001", "istale001", "ilive0001", "iunknown1"].map((id) => reader(id, SESSION)),
			intents: Object.fromEntries(["ilander01", "idone0001", "igone0001", "istale001", "ilive0001"].map((id) => [id, { id, premises: [asserted("a1")] }])),
			failing: ["ilander01:a1", "idone0001:a1", "igone0001:a1", "istale001:a1", "ilive0001:a1"],
		};
		const h = fake(world);
		await invalidateWith(h.deps, landed({ changedSymbols: [SESSION] }));
		expect(h.breaks.map((item) => item.id)).toEqual(["ilive0001", "ilive0001"]);
		// Only the live Intent's assertion was even run.
		expect(h.runs[0]?.assertions.map((item) => item.id)).toEqual(["ilive0001:a1"]);
	});

	it("does nothing the second time it sees a commit", async () => {
		const world: World = { statuses: { ireader01: "working" }, readers: [reader("ireader01", SESSION)], intents: { ireader01: { id: "ireader01", premises: [asserted("a1")] } }, failing: ["ireader01:a1"] };
		const h = fake(world);
		expect((await invalidateWith(h.deps, landed({ changedSymbols: [SESSION] }))).skipped).toBe(false);
		expect(h.breaks).toHaveLength(2);
		expect(await invalidateWith(h.deps, landed({ changedSymbols: [SESSION] }))).toEqual({ skipped: true, broken: [], intents: [], stale: [] });
		expect(h.breaks).toHaveLength(2);
		expect(h.runs).toHaveLength(1);
		expect(h.metricsPublished()).toBe(1);
		// A different commit is processed.
		expect((await invalidateWith(h.deps, landed({ commit: "d".repeat(40) }))).skipped).toBe(false);
	});

	it("only reports a break the Intent actually recorded", async () => {
		const world: World = { statuses: { ireader01: "working", ireader02: "working" }, readers: [reader("ireader01", SESSION), reader("ireader02", SESSION)], intents: {}, failing: [] };
		const h = fake(world);
		h.deps.breakPremise = async (id) => ({ broken: id === "ireader02" });
		const result = await invalidateWith(h.deps, landed({ changedSymbols: [SESSION] }));
		expect(result.broken.map((item) => item.intentId)).toEqual(["ireader02"]);
	});

	it("breaks no assertion when the new trunk does not load at all", async () => {
		const world: World = { statuses: { iasserts1: "working" }, readers: [], intents: { iasserts1: { id: "iasserts1", premises: [asserted("a1")] } }, failing: [], loadError: "syntax error in src/a.ts:1" };
		const h = fake(world);
		expect((await invalidateWith(h.deps, landed())).broken).toEqual([]);
		expect(h.breaks).toEqual([]);
	});

	it("when one commit carries several Intents, each break names the Intent that changed that symbol", async () => {
		const world: World = {
			statuses: { ibatch001: "landed", ibatch002: "landed", ireader01: "working", ireader02: "working", ireader03: "working" },
			readers: [reader("ireader01", SESSION), reader("ireader02", TAX), reader("ireader03", VERIFY)],
			intents: {},
			failing: [],
		};
		const h = fake(world);
		await invalidateWith(h.deps, landed({ byIntent: "ibatch001", changedSymbols: [SESSION, TAX, VERIFY], changedBy: { [SESSION]: "ibatch001", [TAX]: "ibatch002" } }));
		expect(h.breaks.map((item) => [item.id, item.by.intentId, item.by.reason])).toEqual([
			["ireader01", "ibatch001", "type surface of Session changed in intent ibatch001"],
			["ireader02", "ibatch002", "type surface of taxFor changed in intent ibatch002"],
			// Not listed: put down to the Intent the landing as a whole is put down to.
			["ireader03", "ibatch001", "type surface of verifySession changed in intent ibatch001"],
		]);
	});

	it("names a push from outside the gate as the cause", async () => {
		const world: World = { statuses: { ireader01: "working" }, readers: [reader("ireader01", SESSION)], intents: { ireader01: { id: "ireader01", premises: [asserted("a1", VERIFY)] } }, failing: ["ireader01:a1"] };
		const h = fake(world);
		await invalidateWith(h.deps, landed({ byIntent: null, changedSymbols: [SESSION] }));
		expect(h.breaks.map((item) => [item.by.intentId, item.by.reason])).toEqual([
			[OUTSIDE_PUSH, "type surface of Session changed in a push to trunk"],
			[OUTSIDE_PUSH, "assertion 'premise a1' no longer holds after a push to trunk"],
		]);
	});
});

describe("the pure parts", () => {
	it("surfaceBreaks reports each reader and symbol once", () => {
		const breaks = surfaceBreaks([reader("ia", SESSION), reader("ia", SESSION), reader("ia", VERIFY), reader("ib", SESSION)], new Set(["ia"]), "ix");
		expect(breaks.map((item) => [item.intentId, item.symbol])).toEqual([["ia", SESSION], ["ia", VERIFY]]);
	});

	it("assertionChecks takes only assertions that still hold", () => {
		const checks = assertionChecks([{ id: "ia", premises: [observed(VERIFY), asserted("a1"), asserted("a2", TAX, "broken")] }, { id: "ib", premises: [] }]);
		expect(checks).toEqual([{ runId: "ia:a1", intentId: "ia", symbol: VERIFY, assertion: assertion("a1") }]);
	});

	it("assertionBreaks matches failures back to their Intent by run id", () => {
		const checks = assertionChecks([{ id: "ia", premises: [asserted("a1")] }, { id: "ib", premises: [asserted("a1")] }]);
		const run = { assertions: [{ id: "ia:a1", ok: true, ms: 1 }, { id: "ib:a1", ok: false, error: "x", ms: 1 }] };
		expect(assertionBreaks(checks, run, "ix").map((item) => item.intentId)).toEqual(["ib"]);
		expect(assertionBreaks(checks, { ...run, loadError: "broken" }, "ix")).toEqual([]);
	});
});
