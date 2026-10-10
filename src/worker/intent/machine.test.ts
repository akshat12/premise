import { describe, expect, it } from "vitest";
import type { IntentStatus, Premise } from "../../shared/types";
import { canTransition, CAN_GO_STALE, IllegalTransition, IN_FLIGHT, type IntentAction, TERMINAL, transition } from "./machine";
import { markBroken, premisesForRederive, upsertPremise } from "./premises";

const SHA = "a".repeat(40);
const ALL: IntentStatus[] = ["planning", "claiming", "waiting", "working", "submitted", "checking", "quarantined", "queued", "gating", "landed", "stale", "rederiving", "escalated", "failed"];

describe("transition: allowed edges", () => {
	const edges: [IntentStatus, IntentAction, IntentStatus][] = [
		["planning", { a: "claim" }, "claiming"],
		["claiming", { a: "granted" }, "working"],
		["claiming", { a: "wait" }, "waiting"],
		["claiming", { a: "escalate" }, "escalated"],
		["waiting", { a: "resume" }, "claiming"],
		["working", { a: "submit", commit: SHA }, "submitted"],
		["submitted", { a: "check" }, "checking"],
		["checking", { a: "queue" }, "queued"],
		["checking", { a: "quarantine" }, "quarantined"],
		["quarantined", { a: "upgrade-granted" }, "queued"],
		["quarantined", { a: "fail" }, "failed"],
		["queued", { a: "gate" }, "gating"],
		["gating", { a: "land", commit: SHA }, "landed"],
		["gating", { a: "stale" }, "stale"],
		["gating", { a: "fail" }, "failed"],
		["working", { a: "stale" }, "stale"],
		["submitted", { a: "stale" }, "stale"],
		["checking", { a: "stale" }, "stale"],
		["queued", { a: "stale" }, "stale"],
		["stale", { a: "rederive" }, "rederiving"],
		["rederiving", { a: "land", commit: SHA }, "landed"],
		["rederiving", { a: "stale" }, "stale"],
		["rederiving", { a: "escalate" }, "escalated"],
		["escalated", { a: "human", choice: "Split" }, "claiming"],
		["escalated", { a: "human", choice: "Wait" }, "claiming"],
		["escalated", { a: "human", choice: "Depend" }, "claiming"],
		["escalated", { a: "human", choice: "Retry" }, "rederiving"],
		["escalated", { a: "human", choice: "Abandon" }, "failed"],
	];
	for (const [from, action, to] of edges) {
		it(`${from} -${action.a}${"choice" in action ? `(${action.choice})` : ""}-> ${to}`, () => {
			expect(transition(from, action)).toBe(to);
		});
	}

	it("lets any unfinished Intent fail", () => {
		for (const from of ALL.filter((status) => !TERMINAL.includes(status))) {
			expect(transition(from, { a: "fail" })).toBe("failed");
		}
	});

	it("walks the happy path from planning to landed", () => {
		const path: IntentAction[] = [{ a: "claim" }, { a: "granted" }, { a: "submit", commit: SHA }, { a: "check" }, { a: "queue" }, { a: "gate" }, { a: "land", commit: SHA }];
		expect(path.reduce<IntentStatus>(transition, "planning")).toBe("landed");
	});

	it("walks the re-derive path", () => {
		const path: IntentAction[] = [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }, { a: "land", commit: SHA }];
		expect(path.reduce<IntentStatus>(transition, "planning")).toBe("landed");
	});
});

describe("transition: illegal edges throw", () => {
	const illegal: [IntentStatus, IntentAction][] = [
		["planning", { a: "granted" }],
		["planning", { a: "submit", commit: SHA }],
		["planning", { a: "stale" }],
		["claiming", { a: "submit", commit: SHA }],
		["waiting", { a: "granted" }],
		["working", { a: "land", commit: SHA }],
		["working", { a: "queue" }],
		["submitted", { a: "queue" }],
		["queued", { a: "land", commit: SHA }],
		["stale", { a: "land", commit: SHA }],
		["stale", { a: "gate" }],
		["landed", { a: "stale" }],
		["landed", { a: "fail" }],
		["failed", { a: "fail" }],
		["failed", { a: "claim" }],
		["escalated", { a: "claim" }],
		["working", { a: "human", choice: "Retry" }],
		["escalated", { a: "human", choice: "Whatever" }],
	];
	for (const [from, action] of illegal) {
		it(`${from} cannot ${action.a}`, () => {
			expect(() => transition(from, action)).toThrow(IllegalTransition);
			expect(canTransition(from, action)).toBe(false);
		});
	}

	it("says what was attempted", () => {
		expect(() => transition("landed", { a: "stale" })).toThrow('cannot "stale" an Intent that is landed');
		expect(() => transition("escalated", { a: "human", choice: "Whatever" })).toThrow('unknown choice "Whatever"');
	});

	it("never leaves a terminal status", () => {
		const actions: IntentAction[] = [{ a: "claim" }, { a: "granted" }, { a: "wait" }, { a: "resume" }, { a: "work" }, { a: "check" }, { a: "queue" }, { a: "gate" }, { a: "stale" }, { a: "rederive" }, { a: "escalate" }, { a: "fail" }];
		for (const from of TERMINAL) {
			for (const action of actions) {
				expect(canTransition(from, action)).toBe(false);
			}
		}
	});
});

describe("status groups", () => {
	it("an Intent can go stale exactly where the machine has a stale edge", () => {
		expect(ALL.filter((status) => canTransition(status, { a: "stale" })).sort()).toEqual([...CAN_GO_STALE].sort());
	});

	it("in flight means not finished", () => {
		expect([...IN_FLIGHT, ...TERMINAL].sort()).toEqual([...ALL].sort());
	});
});

const VERIFY = "src/auth/session.ts#verifySession";
const observed = (symbol: string, hash = "h1"): Premise => ({ symbol, source: "observed", surfaceHash: hash, state: "holding" });
const asserted = (symbol: string, id = "a1"): Premise => ({ symbol, source: "asserted", surfaceHash: null, state: "holding", assertion: { id, description: "d", code: "c", imports: [] } });
const BY = { intentId: "i9", commit: SHA, reason: "changed" };

describe("upsertPremise", () => {
	it("adds new premises and replaces a repeat", () => {
		const once = upsertPremise([], observed(VERIFY));
		expect(upsertPremise(once, observed(VERIFY, "h2"))).toEqual([observed(VERIFY, "h2")]);
		expect(upsertPremise(once, observed("src/a.ts#b"))).toHaveLength(2);
	});

	it("keeps observed, derived and asserted premises on one symbol side by side", () => {
		const all = [observed(VERIFY), { ...observed(VERIFY), source: "derived" as const }, asserted(VERIFY, "a1"), asserted(VERIFY, "a2")].reduce(upsertPremise, []);
		expect(all.map((premise) => `${premise.source}:${premise.assertion?.id ?? ""}`)).toEqual(["observed:", "derived:", "asserted:a1", "asserted:a2"]);
	});

	it("never lets a read replace an assertion", () => {
		const premises = upsertPremise(upsertPremise([], asserted(VERIFY)), observed(VERIFY));
		expect(premises.filter((premise) => premise.source === "asserted")).toEqual([asserted(VERIFY)]);
	});

	it("keeps a broken premise broken when the same thing is recorded again", () => {
		const broken = markBroken([observed(VERIFY)], VERIFY, BY).premises;
		expect(upsertPremise(broken, observed(VERIFY))[0]?.state).toBe("broken");
		// A new hash is a new reading of the symbol, so it holds again.
		expect(upsertPremise(broken, observed(VERIFY, "h2"))[0]?.state).toBe("holding");
	});
});

describe("markBroken", () => {
	const premises = [observed(VERIFY), asserted(VERIFY, "a1"), asserted(VERIFY, "a2"), observed("src/a.ts#other")];

	it("breaks every holding premise on the symbol by default", () => {
		const result = markBroken(premises, VERIFY, BY);
		expect(result.changed).toBe(true);
		expect(result.premises.map((premise) => premise.state)).toEqual(["broken", "broken", "broken", "holding"]);
		expect(result.premises[0]?.brokenBy).toEqual(BY);
	});

	it("can break just one assertion, leaving the type-level premise holding", () => {
		const result = markBroken(premises, VERIFY, BY, { assertionId: "a1" });
		expect(result.premises.map((premise) => premise.state)).toEqual(["holding", "broken", "holding", "holding"]);
	});

	it("can break by source", () => {
		const result = markBroken(premises, VERIFY, BY, { sources: ["observed", "derived"] });
		expect(result.premises.map((premise) => premise.state)).toEqual(["broken", "holding", "holding", "holding"]);
	});

	it("reports no change when nothing matched or it was already broken", () => {
		expect(markBroken(premises, "src/none.ts#x", BY).changed).toBe(false);
		const once = markBroken(premises, VERIFY, BY).premises;
		expect(markBroken(once, VERIFY, { ...BY, reason: "again" })).toEqual({ premises: once, changed: false });
	});

	it("does not mutate its input", () => {
		const copy = structuredClone(premises);
		markBroken(premises, VERIFY, BY);
		expect(premises).toEqual(copy);
	});
});

describe("premisesForRederive", () => {
	it("keeps assertions that still hold and drops broken ones and everything that was read", () => {
		const premises = [observed(VERIFY), asserted(VERIFY, "a1"), asserted(VERIFY, "a2")];
		const broken = markBroken(premises, VERIFY, BY, { assertionId: "a1" }).premises;
		expect(premisesForRederive(broken)).toEqual([asserted(VERIFY, "a2")]);
	});
});
