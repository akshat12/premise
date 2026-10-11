import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { newIntentId } from "../../shared/ids";
import type { AcceptanceCheck, Intent, Premise } from "../../shared/types";
import { hub } from "../hub/publish";
import { ledgerShard, readersAcrossShards, requestClaimsAcrossShards } from "../ledger/client";
import { INTENT_METHODS, type IntentApi, intentStub, newIntent } from "./client";
import { IllegalTransition } from "./machine";

const SHA = (char: string) => char.repeat(40);
const ACCEPTANCE: AcceptanceCheck[] = [{ id: "t02-ac1", description: "audits expired sessions", testFile: "tests/audit-expired.test.ts", testName: "an expired session writes an audit entry and returns expired" }];

// Each test gets its own Intent, and its own module directory so ledger rows do not collide.
let run = 0;
async function setup(overrides: Partial<Intent> = {}) {
	const id = newIntentId();
	const root = `i${Date.now()}x${run++}`;
	const stub = intentStub(env, id);
	const intent = await stub.init(newIntent({ id, kind: "agent", taskId: "t02-audit-expired", goal: "Audit expired sessions", acceptance: ACCEPTANCE, baseCommit: SHA("b"), ...overrides }));
	return { id, stub, intent, symbol: (name: string) => `${root}/auth/file.ts#${name}`, shard: `${root}/auth` };
}

/** Events about one Intent, in order. The hub is shared by every test, so filter by id. */
async function eventsFor(id: string): Promise<PremiseEvent[]> {
	const all = await hub(env).since(0, 5000);
	return all.filter((event) => ("id" in event && event.id === id) || (event.t === "intent.created" && event.intent.id === id));
}

const observed = (symbol: string, hash = "h1"): Premise => ({ symbol, source: "observed", surfaceHash: hash, state: "holding" });
const asserted = (symbol: string): Premise => ({ symbol, source: "asserted", surfaceHash: null, state: "holding", assertion: { id: "a-session-throws", description: "throws on expiry", code: "assert.ok(true)", imports: [] } });

describe("IntentDO: lifecycle", () => {
	it("init stores the Intent and publishes intent.created", async () => {
		const { id, stub, intent } = await setup();
		expect(intent).toMatchObject({ id, repo: id, status: "planning", claims: [], premises: [], headCommit: null, rederiveAttempts: 0 });
		expect(await stub.get()).toEqual(intent);
		const events = await eventsFor(id);
		expect(events.map((event) => event.t)).toEqual(["intent.created"]);
		expect(events[0]).toMatchObject({ intent: { id, status: "planning", taskId: "t02-audit-expired" } });
	});

	it("acts through the happy path to landed, publishing each status", async () => {
		const { id, stub } = await setup();
		await stub.act({ a: "claim" });
		await stub.act({ a: "granted" });
		await stub.act({ a: "submit", commit: SHA("c") });
		await stub.act({ a: "check" });
		await stub.act({ a: "queue" });
		await stub.act({ a: "gate" }, "at the gate");
		const landed = await stub.act({ a: "land", commit: SHA("d") });

		expect(landed).toMatchObject({ status: "landed", headCommit: SHA("d") });
		const events = await eventsFor(id);
		expect(events.flatMap((event) => (event.t === "intent.status" ? [event.status] : []))).toEqual(["claiming", "working", "submitted", "checking", "queued", "gating", "landed"]);
		expect(events.find((event) => event.t === "intent.status" && event.status === "gating")).toMatchObject({ note: "at the gate" });
		// seq is strictly increasing: the order in the log is the order things happened.
		expect(events.map((event) => event.seq)).toEqual([...events.map((event) => event.seq)].sort((a, b) => a - b));
	});

	it("rejects an illegal transition and changes nothing", async () => {
		const { id, stub } = await setup();
		const error = await stub.act({ a: "land", commit: SHA("d") }).catch((e: unknown) => e);
		// The error keeps its class across the Durable Object boundary.
		expect(error).toBeInstanceOf(IllegalTransition);
		expect(error).toMatchObject({ from: "planning", action: "land", message: 'illegal transition: cannot "land" an Intent that is planning' });
		expect((await stub.get()).status).toBe("planning");
		expect((await eventsFor(id)).map((event) => event.t)).toEqual(["intent.created"]);
	});

	it("refuses operations that are not in the client interface", async () => {
		const { id } = await setup();
		const raw = env.INTENT.get(env.INTENT.idFromName(id)) as unknown as { rpc(method: string, args: unknown[]): Promise<{ ok: boolean; error?: { message: string } }> };
		for (const method of ["save", "load", "constructor", "rpc", "fetch", "toString"]) {
			expect(await raw.rpc(method, [])).toMatchObject({ ok: false, error: { message: `IntentDO has no operation "${method}"` } });
		}
	});

	it("fails when used before init", async () => {
		await expect(intentStub(env, newIntentId()).get()).rejects.toThrow(/has not been initialised/);
	});
});

describe("IntentDO: acceptance checks are immutable", () => {
	async function exercise(stub: IntentApi, symbol: (name: string) => string) {
		await stub.act({ a: "claim" });
		await stub.act({ a: "granted" });
		await stub.setClaims([{ symbol: symbol("handleLogin"), mode: "body" }]);
		await stub.setWhy(["one", "two"]);
		await stub.addRejected("rewrite verifySession");
		await stub.setDependsOn(["i00000001"]);
		await stub.recordPremise(observed(symbol("verifySession")));
		await stub.writeOverlay("tests/audit-expired.test.ts", "export const tests = {};\n");
		await stub.setHead(SHA("c"));
		await stub.incRederive();
		await stub.breakPremise(symbol("verifySession"), { intentId: "i9", commit: SHA("e"), reason: "changed" });
		await stub.act({ a: "rederive" });
		await stub.restartOn("fork-r1", SHA("f"));
	}

	it("no method changes them", async () => {
		const { stub, symbol } = await setup();
		await exercise(stub, symbol);
		expect((await stub.get()).acceptance).toEqual(ACCEPTANCE);
	});

	it("init cannot be called twice to replace them", async () => {
		const { stub, intent } = await setup();
		await expect(stub.init({ ...intent, acceptance: [] })).rejects.toThrow(/already initialised; its acceptance checks cannot be replaced/);
		expect((await stub.get()).acceptance).toEqual(ACCEPTANCE);
	});

	it("the client interface offers no way to set them", () => {
		expect(INTENT_METHODS.some((name) => /accept/i.test(name))).toBe(false);
		expect(Object.keys(intentStub(env, newIntentId())).sort()).toEqual([...INTENT_METHODS].sort());
	});
});

describe("IntentDO: premises", () => {
	it("records premises, de-duplicates them, and subscribes in the ledger", async () => {
		const { id, stub, symbol } = await setup();
		const verify = symbol("verifySession");
		await stub.recordPremise(observed(verify, "h1"));
		await stub.recordPremise(observed(verify, "h2"));
		await stub.recordPremise(asserted(verify));
		const intent = await stub.recordPremises([observed(symbol("Session"), "h3"), observed(verify, "h2")]);

		expect(intent.premises.map((premise) => `${premise.symbol.split("#")[1]}:${premise.source}:${premise.surfaceHash}`)).toEqual(["verifySession:observed:h2", "verifySession:asserted:null", "Session:observed:h3"]);
		expect((await eventsFor(id)).filter((event) => event.t === "premise.recorded")).toHaveLength(5);
		// The ledger knows this Intent relies on both symbols, with the latest hash.
		expect(await readersAcrossShards(env, [verify, symbol("Session")])).toEqual([
			{ intentId: id, symbol: symbol("Session"), surfaceHash: "h3" },
			{ intentId: id, symbol: verify, surfaceHash: "h2" },
		]);
	});

	it("breakPremise on a working Intent turns it stale and publishes premise.broken", async () => {
		const { id, stub, symbol } = await setup();
		const verify = symbol("verifySession");
		await stub.act({ a: "claim" });
		await stub.act({ a: "granted" });
		await stub.recordPremises([observed(verify), asserted(verify)]);

		const result = await stub.breakPremise(verify, { intentId: "i01nullxp", commit: SHA("e"), reason: "assertion 'throws on expiry' no longer holds" }, { assertionId: "a-session-throws" });
		expect(result.broken).toBe(true);
		expect(result.intent.status).toBe("stale");
		// Only the assertion broke. The type-level premise on the same symbol still holds.
		expect(result.intent.premises.map((premise) => [premise.source, premise.state])).toEqual([["observed", "holding"], ["asserted", "broken"]]);
		expect(result.intent.premises[1]?.brokenBy).toEqual({ intentId: "i01nullxp", commit: SHA("e"), reason: "assertion 'throws on expiry' no longer holds" });

		const events = await eventsFor(id);
		expect(events.at(-2)).toMatchObject({ t: "premise.broken", id, symbol: verify, byIntent: "i01nullxp", commit: SHA("e") });
		expect(events.at(-1)).toMatchObject({ t: "intent.status", status: "stale", note: "assertion 'throws on expiry' no longer holds" });
	});

	it("a type-surface change does not void a re-derive in progress; a broken assertion still does", async () => {
		const { id, stub, symbol } = await setup();
		const verify = symbol("verifySession");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await stub.act(action);
		}
		await stub.recordPremises([observed(verify), asserted(verify)]);
		const by = { intentId: "i01nullxp", commit: SHA("e"), reason: "type surface of verifySession changed" };

		// The gate will check the re-derived work against trunk as it is by then, so the attempt carries on.
		const surface = await stub.breakPremise(verify, by, { sources: ["observed", "derived"] });
		expect(surface).toMatchObject({ broken: false, intent: { status: "rederiving" } });
		expect(surface.intent.premises.every((premise) => premise.state === "holding")).toBe(true);
		expect((await eventsFor(id)).some((event) => event.t === "premise.broken")).toBe(false);

		// What it asserted about behaviour is another matter.
		const behaviour = await stub.breakPremise(verify, { ...by, reason: "assertion no longer holds" }, { assertionId: "a-session-throws" });
		expect(behaviour).toMatchObject({ broken: true, intent: { status: "stale" } });
	});

	it("breakPremise marks the premise but leaves the status alone when the Intent cannot go stale", async () => {
		const { stub, symbol } = await setup();
		await stub.recordPremise(observed(symbol("verifySession")));
		const result = await stub.breakPremise(symbol("verifySession"), { intentId: "i9", commit: SHA("e"), reason: "changed" });
		expect(result).toMatchObject({ broken: true, intent: { status: "planning" } });
		expect(result.intent.premises[0]?.state).toBe("broken");
	});

	it("breakPremise is a no-op for a symbol the Intent does not rely on, or one already broken", async () => {
		const { id, stub, symbol } = await setup();
		await stub.act({ a: "claim" });
		await stub.act({ a: "granted" });
		await stub.recordPremise(observed(symbol("verifySession")));
		expect((await stub.breakPremise(symbol("somethingElse"), { intentId: "i9", commit: SHA("e"), reason: "x" })).broken).toBe(false);
		await stub.breakPremise(symbol("verifySession"), { intentId: "i9", commit: SHA("e"), reason: "first" });
		expect((await stub.breakPremise(symbol("verifySession"), { intentId: "i9", commit: SHA("e"), reason: "second" })).broken).toBe(false);
		expect((await eventsFor(id)).filter((event) => event.t === "premise.broken")).toHaveLength(1);
	});
});

describe("IntentDO: record fields", () => {
	it("keeps at most three why lines and publishes them", async () => {
		const { id, stub } = await setup();
		const intent = await stub.setWhy([" one ", "", "two", "three", "four"]);
		expect(intent.why).toEqual(["one", "two", "three"]);
		expect((await eventsFor(id)).at(-1)).toMatchObject({ t: "intent.why", why: ["one", "two", "three"] });
	});

	it("stores claims, rejected alternatives, dependencies, head and re-derive count", async () => {
		const { stub, symbol } = await setup();
		await stub.setClaims([{ symbol: symbol("handleLogin"), mode: "body" }]);
		await stub.addRejected("rewrite verifySession");
		await stub.addRejected("skip the audit");
		await stub.setDependsOn(["i1", "i2", "i1"]);
		await stub.setHead(SHA("c"));
		await stub.incRederive();
		expect(await stub.incRederive()).toMatchObject({
			claims: [{ symbol: symbol("handleLogin"), mode: "body" }],
			rejectedAlternatives: ["rewrite verifySession", "skip the audit"],
			dependsOn: ["i1", "i2"],
			headCommit: SHA("c"),
			rederiveAttempts: 2,
		});
	});

	it("landing releases the Intent's ledger rows", async () => {
		const { id, stub, symbol, shard } = await setup();
		const handleLogin = symbol("handleLogin");
		expect(await requestClaimsAcrossShards(env, { intentId: id, claims: [{ symbol: handleLogin, mode: "body" }], priority: 5, dependsOn: [] })).toEqual({ kind: "granted" });
		await stub.setClaims([{ symbol: handleLogin, mode: "body" }]);
		await stub.recordPremise(observed(symbol("verifySession")));
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "submit", commit: SHA("c") }, { a: "check" }, { a: "queue" }, { a: "gate" }, { a: "land", commit: SHA("d") }] as const) {
			await stub.act(action);
		}
		expect(await ledgerShard(env, shard).snapshot()).toEqual({ claims: [], readers: [] });
	});

	it("restartOn points at a fresh fork, keeps holding assertions and clears the rest", async () => {
		const { stub, symbol } = await setup();
		await stub.recordPremises([observed(symbol("verifySession")), asserted(symbol("verifySession"))]);
		await stub.writeOverlay("src/auth/login.ts", "old work");
		await stub.setHead(SHA("c"));
		const intent = await stub.restartOn("i-fork-r1", SHA("f"));
		expect(intent).toMatchObject({ repo: "i-fork-r1", baseCommit: SHA("f"), headCommit: null });
		expect(intent.premises).toEqual([asserted(symbol("verifySession"))]);
		expect(await stub.overlay()).toEqual({});
	});
});

describe("IntentDO: overlay", () => {
	it("stages edits and deletions and reads them back", async () => {
		const { stub } = await setup();
		await stub.writeOverlay("src/auth/login.ts", "v1");
		await stub.writeOverlay("src/auth/login.ts", "v2");
		await stub.writeOverlay("src/auth/old.ts", null);
		await stub.writeOverlay("tests/new.test.ts", "export const tests = {};\n");

		expect(await stub.readOverlay("src/auth/login.ts")).toBe("v2");
		expect(await stub.readOverlay("src/auth/old.ts")).toBeNull();
		expect(await stub.readOverlay("src/untouched.ts")).toBeUndefined();
		expect(await stub.overlay()).toEqual({ "src/auth/login.ts": "v2", "src/auth/old.ts": null, "tests/new.test.ts": "export const tests = {};\n" });

		await stub.clearOverlay();
		expect(await stub.overlay()).toEqual({});
	});

	it("holds a large file", async () => {
		const { stub } = await setup();
		const big = "x".repeat(300_000);
		await stub.writeOverlay("src/big.ts", big);
		expect(await stub.readOverlay("src/big.ts")).toHaveLength(300_000);
	});
});
