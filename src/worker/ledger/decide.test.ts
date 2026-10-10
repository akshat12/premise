import { describe, expect, it } from "vitest";
import type { Claim } from "../../shared/types";
import { type ClaimRequest, decide, type HeldClaim, isStalemate, type LedgerHistoryEntry } from "./decide";

const TOTAL = "src/billing/invoice.ts#computeTotal";
const TAX = "src/billing/tax.ts#taxFor";
const DISCOUNT = "src/billing/discount.ts#applyDiscounts";
const NUMBER = "src/billing/invoice.ts#nextInvoiceNumber";

const body = (symbol: string): Claim => ({ symbol, mode: "body" });
const iface = (symbol: string): Claim => ({ symbol, mode: "interface" });
const held = (intentId: string, claim: Claim, overrides: Partial<HeldClaim> = {}): HeldClaim => ({ intentId, ...claim, since: 100, priority: 5, ...overrides });
const request = (intentId: string, claims: Claim[], overrides: Partial<ClaimRequest> = {}): ClaimRequest => ({ intentId, claims, priority: 5, dependsOn: [], ...overrides });

describe("decide: granted", () => {
	it("grants when nothing is held", () => {
		expect(decide(request("a", [body(TOTAL)]), [])).toEqual({ kind: "granted" });
	});

	it("grants when others hold different symbols", () => {
		expect(decide(request("a", [body(TOTAL)]), [held("b", body(TAX)), held("c", iface(DISCOUNT))])).toEqual({ kind: "granted" });
	});

	it("grants an empty request", () => {
		expect(decide(request("a", []), [held("b", body(TOTAL))])).toEqual({ kind: "granted" });
	});

	it("ignores the requester's own claims", () => {
		expect(decide(request("a", [body(TOTAL), body(TAX)]), [held("a", body(TOTAL))])).toEqual({ kind: "granted" });
	});
});

describe("decide: depend", () => {
	it("depends when the holder is changing the interface and the requester only needs the body", () => {
		expect(decide(request("a", [body(TOTAL)]), [held("b", iface(TOTAL))])).toEqual({ kind: "depend", on: "b", symbols: [TOTAL] });
	});

	it("depends even when both sides have other symbols (Depend is checked before Split)", () => {
		const decision = decide(request("a", [body(TOTAL), body(DISCOUNT)]), [held("b", iface(TOTAL)), held("b", body(TAX))]);
		expect(decision).toEqual({ kind: "depend", on: "b", symbols: [TOTAL] });
	});

	it("depends when the requester already declared the dependency", () => {
		expect(decide(request("a", [body(TOTAL)], { dependsOn: ["b"] }), [held("b", body(TOTAL))])).toEqual({ kind: "depend", on: "b", symbols: [TOTAL] });
	});

	it("does not depend when the requester wants the interface too", () => {
		expect(decide(request("a", [iface(TOTAL)]), [held("b", iface(TOTAL))]).kind).toBe("wait");
	});

	it("does not depend when only some contested symbols qualify", () => {
		const decision = decide(request("a", [body(TOTAL), body(NUMBER)]), [held("b", iface(TOTAL)), held("b", body(NUMBER))]);
		expect(decision).toEqual({ kind: "wait", on: "b", symbols: [NUMBER, TOTAL].sort() });
	});
});

describe("decide: split", () => {
	it("splits when both sides also have a symbol that is not contested; a tie keeps the holder", () => {
		// The demo pair: t05 holds taxFor + computeTotal, t06 asks for applyDiscounts + computeTotal.
		const decision = decide(request("t06", [body(DISCOUNT), body(TOTAL)]), [held("t05", body(TAX)), held("t05", body(TOTAL))]);
		expect(decision).toEqual({ kind: "split", with: "t05", proposal: { mine: [DISCOUNT], theirs: [TOTAL, TAX].sort() } });
	});

	it("gives the contested symbols to the requester when it has higher priority", () => {
		const decision = decide(request("a", [body(DISCOUNT), body(TOTAL)], { priority: 1 }), [held("b", body(TAX)), held("b", body(TOTAL))]);
		expect(decision).toEqual({ kind: "split", with: "b", proposal: { mine: [DISCOUNT, TOTAL].sort(), theirs: [TAX] } });
	});

	it("keeps them with the holder when the holder has higher priority", () => {
		const decision = decide(request("a", [body(DISCOUNT), body(TOTAL)], { priority: 9 }), [held("b", body(TAX), { priority: 2 }), held("b", body(TOTAL), { priority: 2 })]);
		expect(decision).toMatchObject({ kind: "split", proposal: { mine: [DISCOUNT] } });
	});

	it("counts the requester's claims in other shards as non-contested", () => {
		const decision = decide(request("a", [body(TOTAL)], { elsewhere: 2 }), [held("b", body(TAX)), held("b", body(TOTAL))]);
		expect(decision).toEqual({ kind: "split", with: "b", proposal: { mine: [], theirs: [TOTAL, TAX].sort() } });
	});
});

describe("decide: wait", () => {
	it("waits when the requester wants nothing else", () => {
		expect(decide(request("a", [body(TOTAL)]), [held("b", body(TAX)), held("b", body(TOTAL))])).toEqual({ kind: "wait", on: "b", symbols: [TOTAL] });
	});

	it("waits when the holder holds nothing else", () => {
		expect(decide(request("a", [body(TOTAL), body(DISCOUNT)]), [held("b", body(TOTAL))])).toEqual({ kind: "wait", on: "b", symbols: [TOTAL] });
	});

	it("waits when the two sides want exactly the same symbols", () => {
		const decision = decide(request("a", [body(TOTAL), body(TAX)]), [held("b", body(TOTAL)), held("b", body(TAX))]);
		expect(decision).toEqual({ kind: "wait", on: "b", symbols: [TOTAL, TAX].sort() });
	});
});

describe("decide: several conflicting Intents", () => {
	it("decides against the one with the highest priority", () => {
		const decision = decide(request("a", [body(TOTAL), body(TAX)]), [held("low", body(TOTAL), { priority: 8 }), held("high", body(TAX), { priority: 1 })]);
		expect(decision).toEqual({ kind: "wait", on: "high", symbols: [TAX] });
	});

	it("breaks a priority tie by who has held longest, then by id", () => {
		const older = decide(request("a", [body(TOTAL), body(TAX)]), [held("newer", body(TOTAL), { since: 200 }), held("older", body(TAX), { since: 100 })]);
		expect(older).toMatchObject({ on: "older" });
		const byId = decide(request("a", [body(TOTAL), body(TAX)]), [held("zed", body(TOTAL)), held("abe", body(TAX))]);
		expect(byId).toMatchObject({ on: "abe" });
	});

	it("is deterministic whatever order the held claims arrive in", () => {
		const claims = [held("b", body(TOTAL), { priority: 3 }), held("c", body(TAX), { priority: 3, since: 50 }), held("d", body(DISCOUNT), { priority: 7 })];
		const req = request("a", [body(TOTAL), body(TAX), body(DISCOUNT)]);
		expect(decide(req, [...claims].reverse())).toEqual(decide(req, claims));
		expect(decide(req, claims)).toMatchObject({ on: "c" });
	});
});

describe("isStalemate", () => {
	const split = (intentId: string, other: string): LedgerHistoryEntry => ({ type: "decision", intentId, other, kind: "split" });

	it("is false after one split", () => {
		expect(isStalemate("a", "b", [split("a", "b")])).toBe(false);
	});

	it("is true after two splits between the same pair, in either direction", () => {
		expect(isStalemate("a", "b", [split("a", "b"), split("b", "a")])).toBe(true);
		expect(isStalemate("b", "a", [split("a", "b"), split("a", "b")])).toBe(true);
	});

	it("ignores splits with other Intents and other kinds of decision", () => {
		const history: LedgerHistoryEntry[] = [split("a", "b"), split("a", "c"), split("c", "b"), { type: "decision", intentId: "a", other: "b", kind: "wait" }];
		expect(isStalemate("a", "b", history)).toBe(false);
	});

	it("starts counting again once either Intent lands", () => {
		expect(isStalemate("a", "b", [split("a", "b"), { type: "landed", intentId: "b" }, split("a", "b")])).toBe(false);
		expect(isStalemate("a", "b", [split("a", "b"), split("a", "b"), { type: "landed", intentId: "a" }])).toBe(false);
		expect(isStalemate("a", "b", [split("a", "b"), { type: "landed", intentId: "c" }, split("a", "b")])).toBe(true);
	});

	it("is false with no history", () => {
		expect(isStalemate("a", "b", [])).toBe(false);
	});
});
