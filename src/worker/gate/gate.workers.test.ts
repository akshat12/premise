import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { newIntentId } from "../../shared/ids";
import type { AcceptanceCheck, Assertion, Intent, Premise } from "../../shared/types";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { ledgerShard, requestClaimsAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import type { FileChanges, RepoStore } from "../ports/repo-store";
import { demoTask, seededStore, startIntent } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { landing } from "./client";
import { gateOne } from "./gate";
import type { Landed } from "./invalidate";
import { gateDeps, landIntent, newGateCache } from "./land";

const VERIFY = "src/auth/session.ts#verifySession";
const LOGIN = "src/auth/login.ts#handleLogin";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;
const sessionThrows: Premise = { symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS };

/** An Intent with `changes` pushed to its fork, waiting for the gate (status `queued`). */
async function queued(api: IntentApi, store: RepoStore, intent: Intent, changes: FileChanges): Promise<Intent> {
	await api.act({ a: "claim" });
	await api.act({ a: "granted" });
	const commit = await store.commit(intent.repo, intent.baseCommit, changes, "work");
	await api.act({ a: "submit", commit });
	await api.act({ a: "check" });
	return api.act({ a: "queue" });
}

async function queuedTask(store: ReturnType<typeof seededStore>, taskId: string, patch: string, fields: Partial<Intent> = {}) {
	const started = await startIntent(env, store, taskId, fields);
	return { ...started, intent: await queued(started.api, store, started.intent, referencePatch(patch)) };
}

async function eventsFor(id: string): Promise<PremiseEvent[]> {
	return (await hub(env).since(0, 5000)).filter((event) => ("id" in event && event.id === id) || (event.t === "gate.result" && event.report.intentId === id) || (event.t === "trunk.advanced" && event.byIntent === id));
}

const statusesOf = (events: PremiseEvent[]) => events.flatMap((event) => (event.t === "intent.status" ? [event.status] : []));

describe("the gate on the demo scenario, with the real compiler and runner", () => {
	it("lands t01, then stops t02's clean-looking rebase on its acceptance test", async () => {
		const store = seededStore();
		const deps = gateDeps(env, store, "trunk");
		// All three start from the same trunk, before anything has landed.
		const t01 = await queuedTask(store, "t01-null-expired", "t01");
		const t02 = await queuedTask(store, "t02-audit-expired", "t02", { premises: [sessionThrows] });
		const t04 = await queuedTask(store, "t04-session-ttl-header", "t04");

		// 1. t01 lands. verifySession now returns null instead of throwing, but its signature is the same.
		const first = await gateOne(deps, t01.intent, "rebase");
		expect(first.report).toMatchObject({ textConflict: false, typecheck: { ok: true }, ok: true });
		expect(first.report.tests.passed).toEqual(demoTask("t01-null-expired").acceptance.map((check) => check.testName));
		expect(first.changedSymbols).not.toContain(VERIFY);
		const afterT01 = await store.head("trunk");
		expect(first.report.landedCommit).toBe(afterT01);

		// 2. t02 rebases without a text conflict and typechecks. A plain rebase would ship it.
		//    The acceptance test and the premise assertion both say no.
		const second = await gateOne(deps, t02.intent, "rebase");
		expect(second.report).toMatchObject({ textConflict: false, typecheck: { ok: true, errors: [] }, ok: false, landedCommit: null });
		expect(second.report.tests.failed.map((failure) => failure.name)).toContain("an expired session writes an audit entry and returns expired");
		expect(second.report.tests.failed[0]?.error).toContain("session_expired");
		expect(second.report.assertions).toEqual({ passed: [], failed: [{ id: "a-session-throws", error: expect.stringContaining("SessionExpiredError") }] });
		expect(second.changedSymbols).toEqual([]);
		expect(await store.head("trunk")).toBe(afterT01);

		// 3. The control: t04 never relied on the old behaviour, so it lands on the new trunk.
		const control = await gateOne(deps, t04.intent, "rebase");
		expect(control.report).toMatchObject({ textConflict: false, ok: true });
		expect(control.report.tests.failed).toEqual([]);

		// 4. The re-derived t02, written against the new trunk, lands.
		const again = await startIntent(env, store, "t02-audit-expired");
		const commit = await store.commit(again.id, again.intent.baseCommit, referencePatch("t02-rederived"), "re-derived");
		const rederived = await gateOne(deps, { ...again.intent, headCommit: commit }, "rederive");
		expect(rederived.report).toMatchObject({ path: "rederive", ok: true });
		expect(rederived.report.tests.passed).toHaveLength(3);

		for (const intent of [t01, t02, t04, again]) {
			await intent.api.act({ a: "fail" }, "test cleanup");
		}
	});
});

describe("landIntent", () => {
	it("lands a queued Intent: status, events, ledger and invalidation", async () => {
		const store = seededStore();
		const cache = newGateCache();
		const invalidated: Landed[] = [];
		const intent = await queuedTask(store, "t01-null-expired", "t01");
		expect(await requestClaimsAcrossShards(env, { intentId: intent.id, claims: [{ symbol: VERIFY, mode: "body" }], priority: 5, dependsOn: [] })).toEqual({ kind: "granted" });
		await intent.api.setClaims([{ symbol: VERIFY, mode: "body" }]);

		const outcome = await landIntent(env, intent.id, "rebase", { gate: gateDeps(env, store, "trunk", cache), cache, invalidate: async (_env, landed) => {
				invalidated.push(landed);
				return { skipped: false, broken: [], intents: [], stale: [] };
			},
		});
		const head = await store.head("trunk");
		expect(outcome).toMatchObject({ kind: "landed", commit: head, changedSymbols: [], stale: [] });

		const after = await intent.api.get();
		expect(after).toMatchObject({ status: "landed", headCommit: head });
		const events = await eventsFor(intent.id);
		expect(statusesOf(events).slice(-2)).toEqual(["gating", "landed"]);
		const tail = events.slice(-4).map((event) => event.t);
		expect(tail).toEqual(["intent.status", "gate.result", "intent.status", "trunk.advanced"]);
		expect(events.find((event) => event.t === "gate.result")).toMatchObject({ report: { intentId: intent.id, path: "rebase", ok: true, landedCommit: head } });
		expect(events.at(-1)).toMatchObject({ t: "trunk.advanced", commit: head, byIntent: intent.id, changedSymbols: [] });

		// Invalidation is told what landed, and gets the new trunk's files.
		expect(invalidated).toHaveLength(1);
		expect(invalidated[0]).toMatchObject({ commit: head, byIntent: intent.id, changedSymbols: [] });
		expect(invalidated[0]?.newTrunkFiles).toEqual(await store.snapshot("trunk", "main"));
		// The files are kept for the next Intent, which rebases onto this commit.
		expect(cache.snapshots.get(head)).toBe(invalidated[0]?.newTrunkFiles);
		// Landing releases its claim.
		expect((await ledgerShard(env, "src/auth").snapshot()).claims.filter((claim) => claim.intentId === intent.id)).toEqual([]);
		// The landed count went out to the UI.
		const metrics = (await hub(env).since(0, 5000)).filter((event) => event.t === "metrics").at(-1);
		expect(metrics?.t === "metrics" && metrics.metrics.intentsLanded).toBeGreaterThanOrEqual(1);
	});

	it("turns an Intent stale on a text conflict, so it can be re-derived", async () => {
		const store = seededStore();
		const intent = await queuedTask(store, "t02-audit-expired", "t02");
		// Someone else lands a different edit to the same lines.
		const login = demoFiles()["src/auth/login.ts"] ?? "";
		const theirs = Object.fromEntries(Object.entries(referencePatch("t02")).map(([path, content]) => [path, path === "src/auth/login.ts" && content !== null ? content.replace(/\n/g, "\n// trunk\n") : content]));
		expect(theirs["src/auth/login.ts"]).not.toBe(login);
		await store.commit("trunk", await store.head("trunk"), theirs, "someone else");
		const trunkHead = await store.head("trunk");

		const outcome = await landIntent(env, intent.id, "rebase", { gate: gateDeps(env, store, "trunk") });
		expect(outcome.kind).toBe("stale");
		expect((await intent.api.get()).status).toBe("stale");
		expect(await store.head("trunk")).toBe(trunkHead);
		const events = await eventsFor(intent.id);
		expect(events.find((event) => event.t === "gate.result")).toMatchObject({ report: { textConflict: true, ok: false, landedCommit: null } });
		expect(events.at(-1)).toMatchObject({ t: "intent.status", status: "stale", note: expect.stringMatching(/^Text conflict with trunk in .*src\/auth\/login\.ts/) });
		expect(events.some((event) => event.t === "trunk.advanced")).toBe(false);
		await intent.api.act({ a: "fail" }, "test cleanup");
	});

	it("turns stale an Intent whose acceptance check does not pass on the new trunk, and says why", async () => {
		const store = seededStore();
		const deps = { gate: gateDeps(env, store, "trunk") };
		const t01 = await queuedTask(store, "t01-null-expired", "t01");
		const t02 = await queuedTask(store, "t02-audit-expired", "t02");
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		const trunkHead = await store.head("trunk");

		const outcome = await landIntent(env, t02.id, "rebase", deps);
		// Not failed: stale. The work was right for the trunk it was written on; it gets re-derived.
		expect(outcome).toMatchObject({ kind: "stale", trunkAt: trunkHead });
		expect(await store.head("trunk")).toBe(trunkHead);
		const events = await eventsFor(t02.id);
		expect(events.at(-1)).toMatchObject({ t: "intent.status", status: "stale", note: expect.stringContaining('Acceptance check failed on the new trunk: "an expired session writes an audit entry and returns expired"') });
		expect(events.some((event) => event.t === "trunk.advanced")).toBe(false);
		await t02.api.act({ a: "fail" }, "test cleanup");
	});

	it("reports a failed re-derived attempt without changing the Intent, so the race can decide", async () => {
		const store = seededStore();
		const deps = { gate: gateDeps(env, store, "trunk") };
		const t01 = await queuedTask(store, "t01-null-expired", "t01");
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		// A "re-derived" t02 that still has the old logic.
		const again = await startIntent(env, store, "t02-audit-expired");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await again.api.act(action);
		}
		await again.api.setHead(await store.commit(again.id, again.intent.baseCommit, referencePatch("t02"), "same as before"));
		const outcome = await landIntent(env, again.id, "rederive", deps);
		expect(outcome.kind).toBe("failed");
		expect((await again.api.get()).status).toBe("rederiving");
		expect((await eventsFor(again.id)).at(-1)).toMatchObject({ t: "gate.result", report: { path: "rederive", ok: false } });
		await again.api.act({ a: "fail" }, "test cleanup");
	});

	it("leaves alone an Intent that is not waiting for the gate", async () => {
		const store = seededStore();
		const working = await startIntent(env, store, "t07-role-check");
		expect(await landIntent(env, working.id, "rebase", { gate: gateDeps(env, store, "trunk") })).toEqual({ kind: "skipped", status: "planning" });
		expect(await landIntent(env, "inosuchone", "rebase", { gate: gateDeps(env, store, "trunk") })).toEqual({ kind: "skipped", status: null });

		// One that went stale while it was queued is skipped too.
		const stale = await queuedTask(store, "t09-currency-format", "t09");
		await stale.api.act({ a: "stale" }, "a premise broke");
		expect(await landIntent(env, stale.id, "rebase", { gate: gateDeps(env, store, "trunk") })).toEqual({ kind: "skipped", status: "stale" });
		expect((await eventsFor(stale.id)).some((event) => event.t === "gate.result")).toBe(false);
		await working.api.act({ a: "fail" }, "test cleanup");
		await stale.api.act({ a: "fail" }, "test cleanup");
	});

	it("carries on with an Intent an earlier attempt left in `gating`", async () => {
		const store = seededStore();
		const intent = await queuedTask(store, "t09-currency-format", "t09");
		await intent.api.act({ a: "gate" });
		expect((await landIntent(env, intent.id, "rebase", { gate: gateDeps(env, store, "trunk") })).kind).toBe("landed");
		expect((await intent.api.get()).status).toBe("landed");
	});
});

describe("the Landing Durable Object", () => {
	/** A queued Intent on the store the Worker itself uses, adding one new source file and its own test. */
	async function queuedOnTrunk(taskId: string) {
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const id = newIntentId();
		const { head } = await store.fork(trunk, id);
		const acceptance: AcceptanceCheck[] = [{ id: "ac1", description: "the marker is exported", testFile: `tests/gate-${id}.test.ts`, testName: "the marker is exported" }];
		const api = intentStub(env, id);
		const intent = await api.init(newIntent({ id, kind: "agent", taskId, goal: `Add the ${id} marker`, acceptance, baseCommit: head }));
		const changes: FileChanges = {
			[`src/util/gate_${id}.ts`]: `export const MARK: string = "${id}";\n`,
			[`tests/gate-${id}.test.ts`]: `import { MARK } from "../src/util/gate_${id}.js";\n\nexport const tests: Record<string, () => void> = {\n\t"the marker is exported": () => {\n\t\tif (MARK !== "${id}") {\n\t\t\tthrow new Error("wrong marker");\n\t\t}\n\t},\n};\n`,
		};
		await queued(api, store, intent, changes);
		return { id, api, store, trunk };
	}

	async function drained(timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const status = await landing(env).status();
			if (status.queue.length === 0 && !status.busy) {
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(`the gate did not drain: ${JSON.stringify(status)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	it("lands two queued Intents in order and publishes what happened", async () => {
		await drained(); // anything earlier tests left behind
		const first = await queuedOnTrunk("t07-role-check");
		const second = await queuedOnTrunk("t09-currency-format");
		const before = await first.store.head(first.trunk);

		await landing(env).enqueue(first.id);
		await landing(env).enqueue(second.id);
		await drained();

		const [a, b] = await Promise.all([first.api.get(), second.api.get()]);
		expect([a.status, b.status]).toEqual(["landed", "landed"]);
		// The second landed on top of the first.
		expect(a.headCommit).not.toBe(before);
		expect(b.headCommit).toBe(await first.store.head(first.trunk));
		expect(b.headCommit).not.toBe(a.headCommit);
		const trunk = await first.store.snapshot(first.trunk, "main");
		expect(trunk[`src/util/gate_${first.id}.ts`]).toContain(first.id);
		expect(trunk[`src/util/gate_${second.id}.ts`]).toContain(second.id);
		expect(Object.keys(trunk).some((path) => path.startsWith(".intent/"))).toBe(false);

		const all = await hub(env).since(0, 5000);
		const advanced = all.filter((event) => event.t === "trunk.advanced" && (event.byIntent === first.id || event.byIntent === second.id));
		expect(advanced.map((event) => event.t === "trunk.advanced" && [event.byIntent, event.commit])).toEqual([[first.id, a.headCommit], [second.id, b.headCommit]]);
		for (const intent of [first, second]) {
			const events = await eventsFor(intent.id);
			expect(statusesOf(events).slice(-3)).toEqual(["queued", "gating", "landed"]);
			expect(events.find((event) => event.t === "gate.result")).toMatchObject({ report: { path: "rebase", textConflict: false, typecheck: { ok: true }, tests: { passed: ["the marker is exported"], failed: [] }, ok: true } });
		}
		expect(await landing(env).status()).toEqual({ queue: [], busy: false, stale: [], rederiving: [] });
	});

	it("orders its queue by task order and shows it in status()", async () => {
		await drained();
		// Intents that do not exist are dropped when their turn comes; until then they sit in the queue.
		const ghost = `ighost${Date.now().toString(36)}`;
		await landing(env).enqueue(ghost);
		const seen = (await landing(env).status()).queue.find((entry) => entry.intentId === ghost);
		if (seen !== undefined) {
			expect(seen).toMatchObject({ path: "rebase", attempts: 0 });
			expect(seen.priority).toBeGreaterThan(12); // not one of the 12 tasks, so it goes last
		}
		await drained();
		expect((await landing(env).status()).queue).toEqual([]);
	});

	it("fails an Intent it cannot check after a few tries, instead of leaving it stuck", async () => {
		await drained();
		const intent = await queuedOnTrunk("t12-password-policy");
		// Its fork disappears, so the gate cannot read what it pushed.
		await intent.store.remove(intent.id);
		await landing(env).enqueue(intent.id);
		await drained(30_000);
		const after = await intent.api.get();
		expect(after.status).toBe("failed");
		const last = (await eventsFor(intent.id)).at(-1);
		expect(last).toMatchObject({ t: "intent.status", status: "failed", note: expect.stringContaining("The gate could not check this Intent") });
	}, 40_000);

	it("clear() empties the queue", async () => {
		await drained();
		await landing(env).clear();
		expect(await landing(env).status()).toEqual({ queue: [], busy: false, stale: [], rederiving: [] });
	});
});
