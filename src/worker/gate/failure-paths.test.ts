// What the gate's pure logic does when a call fails or an edge case comes up. These were written by an
// independent verifier (2026-10-12) as attempts to break claims about the gate, and kept as regression tests.
import { describe, expect, it } from "vitest";
import type { Assertion, Intent, IntentStatus, Premise } from "../../shared/types";
import { unanswered } from "../agent/tools";
import { isAbout } from "../intent/premises";
import type { BreakScope, BrokenBy } from "../intent/premises";
import type { Reader } from "../ledger/ledger-shard";
import type { FileMap } from "../ports/repo-store";
import type { RunRequest, RunResult } from "../runner";
import { sameAsStopped } from "./gate";
import { type InvalidateDeps, invalidateWith, type Landed } from "./invalidate";
import { stoppedOver } from "./rederive";

const VERIFY = "src/auth/session.ts#verifySession";
const TAX = "src/billing/tax.ts#taxFor";
const COMMIT = "c".repeat(40);
const assertion = (id: string, code = ""): Assertion => ({ id, description: `premise ${id}`, code, imports: ["src/auth/session.ts"] });
const asserted = (id: string, symbol = VERIFY, state: Premise["state"] = "holding", code = ""): Premise => ({ symbol, source: "asserted", surfaceHash: null, state, assertion: assertion(id, code) });
const reader = (intentId: string, symbol: string): Reader => ({ intentId, symbol, surfaceHash: "h" });
const landed = (fields: Partial<Landed> = {}): Landed => ({ commit: COMMIT, byIntent: "ilander01", changedSymbols: [], newTrunkFiles: { "src/a.ts": "export const a = 1;\n" }, ...fields });

interface World {
	statuses: Record<string, IntentStatus>;
	readers: Reader[];
	intents: Record<string, Pick<Intent, "id" | "premises">>;
	failing: string[];
}
type Break = (id: string, symbol: string, by: BrokenBy, scope: BreakScope) => Promise<{ broken: boolean; stale?: boolean }>;
function fake(world: World, overrides: Partial<InvalidateDeps> & { breakPremise?: Break } = {}) {
	const processed = new Set<string>();
	const told: string[] = [];
	const deps: InvalidateDeps = {
		claimCommit: async (commit) => !processed.has(commit) && processed.add(commit) !== undefined,
		registry: async () => Object.entries(world.statuses).map(([id, status]) => ({ id, status })),
		readersOf: async (symbols) => world.readers.filter((item) => symbols.includes(item.symbol)),
		asserters: async () => Object.values(world.intents).filter((intent) => intent.premises.some((premise) => premise.source === "asserted")).map((intent) => intent.id),
		getIntent: async (id) => world.intents[id] ?? null,
		async breakPremise(id) {
			told.push(id);
			return { broken: true, stale: true };
		},
		async run(req: RunRequest): Promise<RunResult> {
			return { tests: [], assertions: req.assertions.map((item) => ({ id: item.id, ok: !world.failing.includes(item.id), error: world.failing.includes(item.id) ? "it returned" : undefined, ms: 1 })) };
		},
		publishMetrics: async () => undefined,
		...overrides,
	};
	return { deps, told };
}

describe("B7 invalidateWith when telling one Intent fails", () => {
	const world: World = {
		statuses: { ilander01: "landed", ia: "working", ib: "queued", ic: "working" },
		readers: [],
		intents: { ia: { id: "ia", premises: [asserted("a1")] }, ib: { id: "ib", premises: [asserted("a1")] }, ic: { id: "ic", premises: [asserted("a1")] } },
		failing: ["ia:a1", "ib:a1", "ic:a1"],
	};

	it("7e. one Intent cannot be reached at all (every try throws): the other two are still told and are returned as stale", async () => {
		const calls: string[] = [];
		const { deps } = fake(world, {
			async breakPremise(id) {
				calls.push(id);
				if (id === "ib") {
					throw new Error("Durable Object is overloaded");
				}
				return { broken: true, stale: true };
			},
		});
		const result = await invalidateWith(deps, landed());
		expect(result.stale.sort()).toEqual(["ia", "ic"]);
		expect(calls.filter((id) => id === "ib")).toHaveLength(3);
	});

	it("7f. the first try REACHED the Intent (premise marked, Intent stale) but its answer was lost; the retry answers as IntentDO does for an already-broken premise. The Intent this call turned stale must still be returned", async () => {
		// IntentDO.breakPremise on an already-broken premise returns { broken: false, intent } and the intent is stale by then:
		// invalidateDeps.breakPremise maps that to { broken: false, stale: true }.
		const state: Record<string, "holding" | "broken"> = { ia: "holding", ib: "holding", ic: "holding" };
		let lost = 1;
		const { deps } = fake(world, {
			async breakPremise(id) {
				const was = state[id];
				state[id] = "broken";
				if (id === "ib" && lost > 0) {
					lost--;
					throw new Error("Network connection lost."); // applied, answer lost
				}
				return was === "holding" ? { broken: true, stale: true } : { broken: false, stale: true };
			},
		});
		const result = await invalidateWith(deps, landed());
		expect(state.ib).toBe("broken"); // it WAS marked by this call
		expect(result.stale.sort()).toEqual(["ia", "ib", "ic"]);
	});

	it("7g. surface breaks are applied (Intents are now stale), then the read of the asserters fails on all three tries: the Intents already turned stale must not be lost", async () => {
		const surfaceWorld: World = { statuses: { ilander01: "landed", ir1: "working", ir2: "queued" }, readers: [reader("ir1", VERIFY), reader("ir2", VERIFY)], intents: {}, failing: [] };
		const { deps, told } = fake(surfaceWorld, {
			asserters: async () => {
				throw new Error("hub read failed");
			},
		});
		let result: Awaited<ReturnType<typeof invalidateWith>> | undefined;
		let thrown: unknown;
		try {
			result = await invalidateWith(deps, landed({ changedSymbols: [VERIFY] }));
		} catch (error) {
			thrown = error;
		}
		expect(told.sort()).toEqual(["ir1", "ir2"]); // both were turned stale
		expect(result?.stale.sort()).toEqual(["ir1", "ir2"]);
	});
});

describe("B1 sameAsStopped edge cases (pure)", () => {
	const oldTrunk: FileMap = { "src/a.ts": "a0", "src/b.ts": "b0", "tests/a.test.ts": "t0" };
	it("1x. a redo that DROPS part of the stopped work (keeps the edit to a.ts, leaves b.ts alone) is different work and should not be called the same", () => {
		const stopped: FileMap = { ...oldTrunk, "src/a.ts": "a1", "src/b.ts": "b1-catches-the-throw" };
		const newTrunk: FileMap = { ...oldTrunk, "src/c.ts": "c-changed-by-the-lander" };
		const redo: FileMap = { ...newTrunk, "src/a.ts": "a1" }; // b.ts untouched this time
		// The trunk the stopped work started from is what shows that the stopped work also changed b.ts.
		expect(sameAsStopped(newTrunk, redo, stopped, oldTrunk)).toBeNull();
		// Redone in full, it is the same.
		expect(sameAsStopped(newTrunk, { ...redo, "src/b.ts": "b1-catches-the-throw" }, stopped, oldTrunk)).toEqual(["src/a.ts", "src/b.ts"]);
	});
	it("1y. the SAME edit again is not recognised when the landing that broke the premise touched the same file (whole files are compared, not edits)", () => {
		const file = (top: string, body: string) => `${top}\n// ----\n${body}\n`;
		const old: FileMap = { "src/a.ts": file("top-old", "body-old") };
		const stopped: FileMap = { "src/a.ts": file("top-old", "body-EDIT") };
		const newTrunk: FileMap = { "src/a.ts": file("top-NEW-from-lander", "body-old") };
		const redo: FileMap = { "src/a.ts": file("top-NEW-from-lander", "body-EDIT") }; // the identical edit, redone
		// Given where the stopped work started, the edit is carried onto the new trunk as a rebase would carry it.
		expect(sameAsStopped(newTrunk, redo, stopped, old)).toEqual(["src/a.ts"]);
		// A different edit to the same file is different work.
		expect(sameAsStopped(newTrunk, { "src/a.ts": file("top-NEW-from-lander", "body-ANOTHER") }, stopped, old)).toBeNull();
	});
	it("1z. a later break of another asserted premise replaces the remembered stopped work, so the FIRST stopped work is no longer what a redo is compared with", () => {
		const p1 = asserted("a1", VERIFY, "broken");
		const p2 = asserted("a2", TAX, "broken");
		const first = stoppedOver({ repo: "i1", baseCommit: "b0", headCommit: "c0", stopped: undefined }, [p1]);
		const second = stoppedOver({ repo: "i1-r1", baseCommit: "b1", headCommit: "c1", stopped: first }, [p2]);
		expect(second?.work).toEqual({ repo: "i1-r1", commit: "c1", base: "b1" });
		expect(second?.over.map((premise) => premise.symbol)).toEqual([TAX]); // VERIFY is no longer asked about either
	});
});

describe("B6 what counts as an assertion 'about' the broken symbol (pure)", () => {
	const broke = asserted("a-old", VERIFY, "broken");
	it("6x. an assertion that only names verifySession( in a COMMENT, and really checks taxFor, should not answer for verifySession", () => {
		const held = asserted("a1", TAX, "holding", "assert.eq(taxFor(105, 1000), 11); // verifySession() used to throw");
		expect(unanswered([broke], [held], [])).toEqual([broke]);
	});
	it("6y. a call of a method with the same name on something else (store.verifySession(...)) should not answer for src/auth/session.ts#verifySession", () => {
		const held = asserted("a1", TAX, "holding", "const store = { verifySession: (x: string) => x }; assert.eq(store.verifySession('a'), 'a'); assert.eq(taxFor(105, 1000), 11);");
		expect(unanswered([broke], [held], [])).toEqual([broke]);
	});
	it("6z. the claimed cases: called whatever the filing; no_behaviour is not consulted here; changing the symbol; symbol gone", () => {
		const calls = asserted("a1", "src/store/memory-store.ts#createMemorySessionStore", "holding", "const s = createMemorySessionStore([]); assert.eq(verifySession('x', s, () => 1), null);");
		expect(unanswered([broke], [calls], [])).toEqual([]);
		expect(unanswered([broke], [], [VERIFY])).toEqual([]);
		expect(unanswered([broke], [], [], () => false)).toEqual([]);
		expect(unanswered([broke], [], [])).toEqual([broke]);
		expect(unanswered([broke], [{ ...broke }], [])).toEqual([broke]); // a broken one it still holds answers nothing
	});
});
