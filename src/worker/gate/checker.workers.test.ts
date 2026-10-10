import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Claim, Intent } from "../../shared/types";
import { hub } from "../hub/publish";
import { ledgerShard, requestClaimsAcrossShards } from "../ledger/client";
import type { FileChanges } from "../ports/repo-store";
import { seededStore, startIntent } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { runChecker, settleQuarantine } from "./checker";

type Store = ReturnType<typeof seededStore>;
const body = (symbol: string): Claim => ({ symbol, mode: "body" });
const LOGIN = "src/auth/login.ts#handleLogin";
const RECORD = "src/auth/audit.ts#record";

/** An Intent that has claimed, worked and pushed `changes`, as the agent run leaves it: status `submitted`. */
async function pushed(store: Store, taskId: string, claims: Claim[], changes: FileChanges) {
	const started = await startIntent(env, store, taskId);
	expect(await requestClaimsAcrossShards(env, { intentId: started.id, claims, priority: 5, dependsOn: [] })).toEqual({ kind: "granted" });
	await started.api.setClaims(claims);
	await started.api.act({ a: "claim" });
	await started.api.act({ a: "granted" });
	const commit = await store.commit(started.id, started.intent.baseCommit, changes, "work");
	await started.api.act({ a: "submit", commit });
	return { ...started, commit };
}

async function eventsFor(id: string): Promise<PremiseEvent[]> {
	return (await hub(env).since(0, 5000)).filter((event) => "id" in event && event.id === id);
}

const withAuditEdit = (): FileChanges => ({ ...referencePatch("t02"), "src/auth/audit.ts": (demoFiles()["src/auth/audit.ts"] ?? "").replace("log.entries.push(entry);", "log.entries.unshift(entry);") });

describe("runChecker", () => {
	it("queues an Intent that stayed within its claims, and records derived premises", async () => {
		const store = seededStore();
		const queuedFor: [string, string][] = [];
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], referencePatch("t02"));
		const result = await runChecker(env, intent.id, { store, enqueue: async (queued, path) => void queuedFor.push([queued.id, path]) });

		expect(result.outOfClaim).toEqual([]);
		const after = await intent.api.get();
		expect(after.status).toBe("queued");
		expect(queuedFor).toEqual([[intent.id, "rebase"]]);

		const derived = after.premises.filter((premise) => premise.source === "derived").map((premise) => premise.symbol);
		expect(derived).toContain("src/auth/session.ts#verifySession");
		expect(derived).toContain("src/auth/session.ts#SessionExpiredError");
		expect(after.premises.every((premise) => premise.surfaceHash !== null && premise.state === "holding")).toBe(true);

		const events = await eventsFor(intent.id);
		expect(events.find((event) => event.t === "push.checked")).toMatchObject({ commit: intent.commit, touched: [LOGIN], outOfClaim: [] });
		expect(events.flatMap((event) => (event.t === "intent.status" ? [event.status] : [])).slice(-2)).toEqual(["checking", "queued"]);
		await intent.api.act({ a: "fail" }, "test cleanup");
	});

	it("does not record a derived premise for a symbol the Intent already observed", async () => {
		const store = seededStore();
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], referencePatch("t02"));
		await intent.api.recordPremise({ symbol: "src/auth/session.ts#verifySession", source: "observed", surfaceHash: "seen", state: "holding" });
		await runChecker(env, intent.id, { store });
		const onVerify = (await intent.api.get()).premises.filter((premise) => premise.symbol === "src/auth/session.ts#verifySession");
		expect(onVerify.map((premise) => premise.source)).toEqual(["observed"]);
		await intent.api.act({ a: "fail" }, "test cleanup");
	});

	it("quarantines an out-of-claim edit, gets the claim upgraded when nobody else holds it, and queues", async () => {
		const store = seededStore();
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], withAuditEdit());
		const result = await runChecker(env, intent.id, { store });

		expect(result.outOfClaim).toEqual([RECORD]);
		const after = await intent.api.get();
		expect(after.status).toBe("queued");
		expect(after.claims).toEqual([body(LOGIN), body(RECORD)]);
		const statuses = (await eventsFor(intent.id)).flatMap((event) => (event.t === "intent.status" ? [event.status] : []));
		expect(statuses.slice(-3)).toEqual(["checking", "quarantined", "queued"]);
		// The ledger now shows it as the writer of the extra symbol.
		expect((await ledgerShard(env, "src/auth").snapshot()).claims.filter((claim) => claim.intentId === intent.id).map((claim) => claim.symbol).sort()).toEqual([RECORD, LOGIN]);
		await intent.api.act({ a: "fail" }, "test cleanup");
	});

	it("leaves the Intent quarantined and asks a person when another Intent holds the symbol", async () => {
		const store = seededStore();
		const holder = await startIntent(env, store, "t03-expired-metrics");
		await requestClaimsAcrossShards(env, { intentId: holder.id, claims: [body(RECORD)], priority: 5, dependsOn: [] });
		await holder.api.setClaims([body(RECORD)]);
		const queuedFor: string[] = [];
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], withAuditEdit());
		await runChecker(env, intent.id, { store, enqueue: async (queued) => void queuedFor.push(queued.id) });

		expect((await intent.api.get()).status).toBe("quarantined");
		expect(queuedFor).toEqual([]);
		const events = await eventsFor(intent.id);
		expect(events.at(-1)).toMatchObject({ t: "human.needed", kind: "stalemate", options: ["Wait", "Split", "Depend"] });
		expect(events.find((event) => event.t === "claim.decision" && event.decision.kind !== "granted")).toMatchObject({ decision: { kind: "wait", on: holder.id }, symbols: [RECORD] });
		await intent.api.act({ a: "fail" }, "test cleanup");
		await holder.api.act({ a: "fail" }, "test cleanup");
	});
});

describe("settleQuarantine", () => {
	async function quarantined() {
		const store = seededStore();
		const holder = await startIntent(env, store, "t03-expired-metrics");
		await requestClaimsAcrossShards(env, { intentId: holder.id, claims: [body(RECORD)], priority: 5, dependsOn: [] });
		await holder.api.setClaims([body(RECORD)]);
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], withAuditEdit());
		await runChecker(env, intent.id, { store });
		expect((await intent.api.get()).status).toBe("quarantined");
		return { store, holder, intent };
	}
	const owner = async (symbol: string) => (await ledgerShard(env, "src/auth").snapshot()).claims.find((claim) => claim.symbol === symbol)?.intentId;

	it("Split gives the contested symbol to the Intent that edited it, and queues it", async () => {
		const { store, holder, intent } = await quarantined();
		const queuedFor: string[] = [];
		const settled = await settleQuarantine(env, intent.id, "Split", { store, enqueue: async (queued) => void queuedFor.push(queued.id) });
		expect(settled).toEqual({ status: "queued", decision: { kind: "granted" } });
		expect(queuedFor).toEqual([intent.id]);
		expect(await owner(RECORD)).toBe(intent.id);
		expect((await intent.api.get()).claims).toEqual([body(LOGIN), body(RECORD)]);
		await intent.api.act({ a: "fail" }, "test cleanup");
		await holder.api.act({ a: "fail" }, "test cleanup");
	});

	it("Wait stays quarantined, then settles by itself when the holder is done", async () => {
		const { store, holder, intent } = await quarantined();
		expect((await settleQuarantine(env, intent.id, "Wait", { store })).status).toBe("quarantined");
		expect(await owner(RECORD)).toBe(holder.id);

		// The holder finishes. That wakes the checker for the quarantined Intent. The wake-up uses the
		// default store, which does not have this test's fork, so call the retry the wake-up would make.
		await holder.api.act({ a: "fail" }, "abandoned");
		expect(await owner(RECORD)).toBeUndefined();
		expect((await settleQuarantine(env, intent.id, "retry", { store })).status).toBe("queued");
		expect(await owner(RECORD)).toBe(intent.id);
		await intent.api.act({ a: "fail" }, "test cleanup");
	});

	it("Depend records the dependency and stays quarantined while the holder is in flight", async () => {
		const { store, holder, intent } = await quarantined();
		expect((await settleQuarantine(env, intent.id, "Depend", { store })).status).toBe("quarantined");
		expect((await intent.api.get()).dependsOn).toEqual([holder.id]);
		await intent.api.act({ a: "fail" }, "test cleanup");
		await holder.api.act({ a: "fail" }, "test cleanup");
	});

	it("does nothing for an Intent that is not quarantined", async () => {
		const store = seededStore();
		const intent = await startIntent(env, store, "t07-role-check");
		expect(await settleQuarantine(env, intent.id, "Split", { store })).toEqual({ status: "planning", decision: null });
	});
});

describe("runChecker: a re-derived Intent", () => {
	it("is checked and handed to the gate without changing status", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await started.api.act(action);
		}
		await started.api.setClaims([body(LOGIN)]);
		const commit = await store.commit(started.id, started.intent.baseCommit, referencePatch("t02"), "re-derived work");
		await started.api.setHead(commit);
		const queuedFor: [string, string, Intent["status"]][] = [];
		await runChecker(env, started.id, { store, enqueue: async (queued, path) => void queuedFor.push([queued.id, path, queued.status]) });
		expect(queuedFor).toEqual([[started.id, "rederive", "rederiving"]]);
		expect((await started.api.get()).premises.some((premise) => premise.source === "derived")).toBe(true);
		await started.api.act({ a: "fail" }, "test cleanup");
	});
});
