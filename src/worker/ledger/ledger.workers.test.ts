import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Claim } from "../../shared/types";
import { groupByShard, isStalemateAcrossShards, ledgerShard, readersAcrossShards, releaseEverywhere, requestClaimsAcrossShards, shardsOf, subscribeAcrossShards } from "./client";
import type { ClaimRequest } from "./decide";

// Storage is shared between test files, so every test works in module directories of its own.
let run = 0;
function space() {
	const root = `t${Date.now()}x${run++}`;
	return {
		billing: (name: string) => `${root}/billing/file.ts#${name}`,
		auth: (name: string) => `${root}/auth/file.ts#${name}`,
		shards: [`${root}/auth`, `${root}/billing`],
	};
}
const body = (symbol: string): Claim => ({ symbol, mode: "body" });
const request = (intentId: string, claims: Claim[], overrides: Partial<ClaimRequest> = {}): ClaimRequest => ({ intentId, claims, priority: 5, dependsOn: [], ...overrides });

describe("ledger client helpers", () => {
	it("groups symbols by shard in sorted order", () => {
		const groups = groupByShard(["src/billing/tax.ts#taxFor", "src/auth/session.ts#verifySession", "src/billing/invoice.ts#computeTotal"], (symbol) => symbol);
		expect(groups).toEqual([
			["src/auth", ["src/auth/session.ts#verifySession"]],
			["src/billing", ["src/billing/tax.ts#taxFor", "src/billing/invoice.ts#computeTotal"]],
		]);
		expect(shardsOf(["src/billing/tax.ts#taxFor", "src/auth/session.ts#verifySession"])).toEqual(["src/auth", "src/billing"]);
	});
});

describe("claims across shards", () => {
	it("grants the first Intent, makes the second wait, and grants it after a release", async () => {
		const s = space();
		const total = s.billing("computeTotal");
		expect(await requestClaimsAcrossShards(env, request("i1", [body(total)]))).toEqual({ kind: "granted" });
		expect(await requestClaimsAcrossShards(env, request("i2", [body(total)]))).toEqual({ kind: "wait", on: "i1", symbols: [total] });

		await releaseEverywhere(env, "i1", s.shards);
		expect(await requestClaimsAcrossShards(env, request("i2", [body(total)]))).toEqual({ kind: "granted" });
		const snapshot = await ledgerShard(env, s.shards[1] ?? "").snapshot();
		expect(snapshot.claims.map((claim) => [claim.intentId, claim.symbol, claim.mode])).toEqual([["i2", total, "body"]]);
	});

	it("is all or nothing: a refusal in a later shard releases what earlier shards granted", async () => {
		const s = space();
		const verify = s.auth("verifySession");
		const total = s.billing("computeTotal");
		expect(await requestClaimsAcrossShards(env, request("holder", [body(total)]))).toEqual({ kind: "granted" });

		// "auth" sorts before "billing", so auth grants first and billing then refuses.
		const decision = await requestClaimsAcrossShards(env, request("i2", [body(verify), body(total)]));
		expect(decision.kind).toBe("wait");
		expect((await ledgerShard(env, s.shards[0] ?? "").snapshot()).claims).toEqual([]);

		// So someone else can take the auth symbol straight away.
		expect(await requestClaimsAcrossShards(env, request("i3", [body(verify)]))).toEqual({ kind: "granted" });
	});

	it("splits the demo pair and gives the requester only its own part", async () => {
		const s = space();
		const tax = s.billing("taxFor");
		const total = s.billing("computeTotal");
		const discount = s.billing("applyDiscounts");
		await requestClaimsAcrossShards(env, request("t05", [body(tax), body(total)]));

		const decision = await requestClaimsAcrossShards(env, request("t06", [body(discount), body(total)]));
		expect(decision).toEqual({ kind: "split", with: "t05", proposal: { mine: [discount], theirs: [total, tax].sort() } });

		const claims = (await ledgerShard(env, s.shards[1] ?? "").snapshot()).claims.map((claim) => `${claim.intentId}:${claim.symbol.split("#")[1]}`);
		expect(claims.sort()).toEqual(["t05:computeTotal", "t05:taxFor", "t06:applyDiscounts"]);
	});

	it("moves a contested symbol when the requester has higher priority", async () => {
		const s = space();
		const tax = s.billing("taxFor");
		const total = s.billing("computeTotal");
		const discount = s.billing("applyDiscounts");
		await requestClaimsAcrossShards(env, request("low", [body(tax), body(total)], { priority: 9 }));
		const decision = await requestClaimsAcrossShards(env, request("high", [body(discount), body(total)], { priority: 1 }));
		expect(decision).toMatchObject({ kind: "split", with: "low", proposal: { mine: [total, discount].sort(), theirs: [tax] } });

		const owners = Object.fromEntries((await ledgerShard(env, s.shards[1] ?? "").snapshot()).claims.map((claim) => [claim.symbol.split("#")[1], claim.intentId]));
		expect(owners).toEqual({ taxFor: "low", computeTotal: "high", applyDiscounts: "high" });
	});

	it("reports a stalemate after two splits between the same pair, until one of them lands", async () => {
		const s = space();
		const tax = s.billing("taxFor");
		const total = s.billing("computeTotal");
		const discount = s.billing("applyDiscounts");
		await requestClaimsAcrossShards(env, request("a", [body(tax), body(total)]));
		await requestClaimsAcrossShards(env, request("b", [body(discount), body(total)]));
		expect(await isStalemateAcrossShards(env, "a", "b", s.shards)).toBe(false);
		await requestClaimsAcrossShards(env, request("b", [body(discount), body(total)]));
		expect(await isStalemateAcrossShards(env, "a", "b", s.shards)).toBe(true);

		await releaseEverywhere(env, "a", s.shards, true);
		expect(await isStalemateAcrossShards(env, "a", "b", s.shards)).toBe(false);
		expect(await requestClaimsAcrossShards(env, request("b", [body(discount), body(total)]))).toEqual({ kind: "granted" });
	});
});

describe("read subscriptions", () => {
	it("returns who relies on the given symbols, across shards", async () => {
		const s = space();
		const verify = s.auth("verifySession");
		const session = s.auth("Session");
		const total = s.billing("computeTotal");
		await subscribeAcrossShards(env, "i1", [{ symbol: verify, surfaceHash: "h1" }, { symbol: total, surfaceHash: "h2" }]);
		await subscribeAcrossShards(env, "i2", [{ symbol: verify, surfaceHash: null }]);
		await subscribeAcrossShards(env, "i3", [{ symbol: session, surfaceHash: "h3" }]);

		const readers = await readersAcrossShards(env, [verify, total]);
		expect(readers).toEqual([
			{ intentId: "i1", symbol: verify, surfaceHash: "h1" },
			{ intentId: "i2", symbol: verify, surfaceHash: null },
			{ intentId: "i1", symbol: total, surfaceHash: "h2" },
		]);
		expect(await readersAcrossShards(env, [])).toEqual([]);
	});

	it("updates a hash on re-subscribe and forgets an Intent on release", async () => {
		const s = space();
		const verify = s.auth("verifySession");
		await subscribeAcrossShards(env, "i1", [{ symbol: verify, surfaceHash: "old" }]);
		await subscribeAcrossShards(env, "i1", [{ symbol: verify, surfaceHash: "new" }]);
		expect(await readersAcrossShards(env, [verify])).toEqual([{ intentId: "i1", symbol: verify, surfaceHash: "new" }]);

		await releaseEverywhere(env, "i1", s.shards);
		expect(await readersAcrossShards(env, [verify])).toEqual([]);
	});
});
