// Attempts to break the gate after it was fixed, with the real compiler, runner, Durable Objects and
// Workflows: a stopped fork that can never be read, the identical edit next to the landing's change,
// retried hand-offs, duplicate stale reports, and assertions written through a namespace import.
// Written by an independent verifier (2026-10-12, second pass) and kept as regression tests.
// "SAFE" tests assert the safe behaviour; "CHARACTERISE" tests record what happens at a known limit.
import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { newIntentId } from "../../shared/ids";
import type { AcceptanceCheck, Assertion, Claim, Intent, Premise } from "../../shared/types";
import { handOff } from "../agent/handoff";
import { type AgentDeps, runAgent } from "../agent/run";
import { callTool, createToolContext } from "../agent/tools";
import { resetDemo } from "../dispatch";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { requestClaimsAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import type { FileChanges, RepoStore } from "../ports/repo-store";
import { demoTask, memorySteps, replay, scriptFor, seededStore, startIntent } from "../testing/agent";
import { demoFiles, demoWith, referencePatch } from "../testing/demo";
import { runChecker } from "./checker";
import { landing } from "./client";
import type { GateDeps } from "./gate";
import type { InvalidateResult } from "./invalidate";
import { gateDeps, landIntent } from "./land";
import { finishRederive, type RaceDeps, startRace } from "./rederive";

type Store = ReturnType<typeof seededStore>;
const VERIFY = "src/auth/session.ts#verifySession";
const LOGIN = "src/auth/login.ts#handleLogin";
const RECORD = "src/auth/audit.ts#record";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;
const sessionThrows: Premise = { symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS };
const noInvalidate = async (): Promise<InvalidateResult> => ({ skipped: false, broken: [], intents: [], stale: [] });
const ADMIN = { "x-admin-token": "test-admin-token", "content-type": "application/json" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const say = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);

async function queued(api: IntentApi, store: RepoStore, intent: Intent, changes: FileChanges): Promise<Intent> {
	await api.act({ a: "claim" });
	await api.act({ a: "granted" });
	const commit = await store.commit(intent.repo, intent.baseCommit, changes, "work");
	await api.act({ a: "submit", commit });
	await api.act({ a: "check" });
	return api.act({ a: "queue" });
}
async function queuedTask(store: Store, taskId: string, patch: string, fields: Partial<Intent> = {}) {
	const started = await startIntent(env, store, taskId, fields);
	return { ...started, intent: await queued(started.api, store, started.intent, referencePatch(patch)) };
}
function racing(deps: { gate: GateDeps; invalidate: typeof noInvalidate }, store: Store) {
	const starts: { attempt: number; reason?: string }[] = [];
	const raceDeps: RaceDeps = { ...deps, store, trunk: "trunk", startAgent: async (_intent, attempt, _broken, reason) => void starts.push({ attempt, ...(reason === undefined ? {} : { reason }) }) };
	return { raceDeps, starts };
}
async function waitFor(api: IntentApi, wanted: Intent["status"][], timeoutMs: number): Promise<Intent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const intent = await api.get();
		if (wanted.includes(intent.status) || Date.now() > deadline) return intent;
		await sleep(100);
	}
}
async function gateIdle(timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = await landing(env).status();
		if (status.queue.length === 0 && !status.busy && status.stale.length === 0 && status.rederiving.length === 0) return true;
		if (Date.now() > deadline) return false;
		await sleep(100);
	}
}
/** An Intent on the store the Worker itself uses, taken by hand to `queued`. */
async function queuedOnTrunk(taskId: string, changes: FileChanges, options: { claims?: Claim[]; premises?: Premise[] } = {}) {
	const store = getRepoStore(env);
	const trunk = await currentTrunk(env);
	const task = demoTask(taskId);
	const id = newIntentId();
	const { head } = await store.fork(trunk, id);
	const api = intentStub(env, id);
	await api.init(newIntent({ id, kind: "agent", taskId, goal: task.goal, acceptance: structuredClone(task.acceptance), baseCommit: head }));
	if (options.claims !== undefined) {
		expect(await requestClaimsAcrossShards(env, { intentId: id, claims: options.claims, priority: 5, dependsOn: [] })).toEqual({ kind: "granted" });
		await api.setClaims(options.claims);
	}
	await api.recordPremises(options.premises ?? []);
	await api.act({ a: "claim" });
	await api.act({ a: "granted" });
	const commit = await store.commit(id, head, changes, "work");
	await api.act({ a: "submit", commit });
	await api.act({ a: "check" });
	await api.act({ a: "queue" });
	return { id, api, commit, base: head };
}
/** An Intent that is none of the demo tasks: one new source file and its own test. */
async function markerOnTrunk() {
	const store = getRepoStore(env);
	const trunk = await currentTrunk(env);
	const id = newIntentId();
	const { head } = await store.fork(trunk, id);
	const acceptance: AcceptanceCheck[] = [{ id: "ac1", description: "the marker is exported", testFile: `tests/gate-${id}.test.ts`, testName: "the marker is exported" }];
	const api = intentStub(env, id);
	const intent = await api.init(newIntent({ id, kind: "agent", taskId: "x07-marker", goal: `Add the ${id} marker`, acceptance, baseCommit: head }));
	await queued(api, store, intent, {
		[`src/util/gate_${id}.ts`]: `export const MARK: string = "${id}";\n`,
		[`tests/gate-${id}.test.ts`]: `import { MARK } from "../src/util/gate_${id}.js";\n\nexport const tests: Record<string, () => void> = {\n\t"the marker is exported": () => {\n\t\tif (MARK !== "${id}") {\n\t\t\tthrow new Error("wrong marker");\n\t\t}\n\t},\n};\n`,
	});
	return { id, api };
}
const about = (id: string) => (event: PremiseEvent) =>
	("id" in event && event.id === id) || (event.t === "gate.result" && event.report.intentId === id) || (event.t === "trunk.advanced" && event.byIntent === id) || (event.t === "artifacts" && (event.repo === id || event.repo.startsWith(`${id}-r`)));
const statuses = (events: PremiseEvent[]) => events.flatMap((event) => (event.t === "intent.status" ? [event.status] : []));
const races = (events: PremiseEvent[]) => events.flatMap((event) => (event.t === "rederive.race" ? [`${event.rebase}/${event.rederive}/${event.winner ?? "-"}`] : []));

// ---------------------------------------------------------------------------------------------------------
describe("C1: the stopped fork can NEVER be read again", () => {
	it("SAFE, through the real Landing object and Workflow: the redo is not landed, the gate is not held, nothing stays queued, and the Intent ends with a person (then Retry, then Abandon)", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		await gateIdle();
		await resetDemo(env);
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const t02 = await queuedOnTrunk("t02-audit-expired", referencePatch("t02"), { claims: [{ symbol: LOGIN, mode: "body" }], premises: [sessionThrows] });
		const t01 = await queuedOnTrunk("t01-null-expired", referencePatch("t01"));
		await landing(env).enqueue(t01.id);

		// As soon as t02 has been pointed at its fresh fork (the race has read the stopped fork for the rebase), the stopped fork goes for good.
		let moved = await t02.api.get();
		for (const deadline = Date.now() + 30_000; moved.repo === t02.id && Date.now() < deadline; moved = await t02.api.get()) {
			await sleep(5);
		}
		await store.remove(t02.id);
		const removedAt = Date.now();
		expect(moved.repo).toBe(`${t02.id}-r1`);
		expect(moved.stopped?.work).toMatchObject({ repo: t02.id, commit: t02.commit, base: t02.base });
		const statusAtRemoval = moved.status;

		// Wait until the gate has tried the redo at least once and could not check it; then offer it another Intent.
		let sawRetry = 0;
		for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
			const entry = (await landing(env).status()).queue.find((item) => item.intentId === t02.id);
			if (entry !== undefined && entry.attempts >= 1) {
				sawRetry = entry.attempts;
				break;
			}
			if (["landed", "escalated", "failed"].includes((await t02.api.get()).status)) break;
			await sleep(20);
		}
		const marker = await markerOnTrunk();
		const markerAt = Date.now();
		await landing(env).enqueue(marker.id);
		const markerEnd = await waitFor(marker.api, ["landed", "failed", "stale"], 30_000);
		const markerMs = Date.now() - markerAt;

		const end = await waitFor(t02.api, ["escalated", "landed", "failed"], 120_000);
		const endMs = Date.now() - removedAt;
		const idle = await gateIdle(30_000);
		const gate = await landing(env).status();
		let events = (await hub(env).since(0, 5000)).filter(about(t02.id));
		const asks = events.flatMap((event) => (event.t === "human.needed" ? [event.message] : []));
		const notes = events.flatMap((event) => (event.t === "intent.status" && event.note !== undefined ? [`${event.status}: ${event.note.slice(0, 110)}`] : []));
		say("C1 run", { statusAtRemoval, gateRetriesSeenBeforeMarker: sawRetry, marker: markerEnd.status, markerMs, end: end.status, attempts: end.rederiveAttempts, msFromRemovalToEnd: endMs, gateIdle: idle, queue: gate.queue.length, stale: gate.stale.length, rederiving: gate.rederiving.length });
		say("C1 statuses", statuses(events));
		say("C1 races", races(events));
		say("C1 gate results (path, ok)", events.flatMap((event) => (event.t === "gate.result" ? [[event.report.path, event.report.ok]] : [])));
		say("C1 notes", notes.slice(-4));
		say("C1 what the person is told", asks.map((message) => message.slice(0, 260)));
		const onTrunk = await store.readFile(trunk, "main", "src/auth/login.ts");
		expect(onTrunk).not.toBe(referencePatch("t02")["src/auth/login.ts"]);
		expect(markerEnd.status).toBe("landed");
		expect(markerMs).toBeLessThan(10_000);
		expect(end.status).toBe("escalated");
		expect(idle).toBe(true);
		expect([...gate.queue, ...gate.stale, ...gate.rederiving].some((item) => item.intentId === t02.id)).toBe(false);
		expect(asks).toHaveLength(1);

		// Retry: one more attempt, which cannot be checked either, and back to a person.
		const retry = await exports.default.fetch(`http://premise.test/api/human/${t02.id}`, { method: "POST", headers: ADMIN, body: JSON.stringify({ choice: "Retry" }) });
		say("C1 Retry answer", await retry.json());
		await sleep(300);
		const again = await waitFor(t02.api, ["escalated", "landed", "failed"], 120_000);
		await gateIdle(30_000);
		events = (await hub(env).since(0, 5000)).filter(about(t02.id));
		say("C1 after Retry", { status: again.status, attempts: again.rederiveAttempts, asks: events.filter((event) => event.t === "human.needed").length });
		expect(again.status).toBe("escalated");
		const abandon = await exports.default.fetch(`http://premise.test/api/human/${t02.id}`, { method: "POST", headers: ADMIN, body: JSON.stringify({ choice: "Abandon" }) });
		say("C1 Abandon answer", await abandon.json());
		expect((await t02.api.get()).status).toBe("failed");
		const after = await landing(env).status();
		expect([...after.queue, ...after.stale, ...after.rederiving].some((item) => item.intentId === t02.id)).toBe(false);
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete").catch(() => undefined)));
	}, 300_000);

	it("SAFE, at the function level: with every read of the stopped fork failing, landIntent throws and lands nothing, and startRace tries no rebase and starts the agent", async () => {
		const store = seededStore();
		const gate = gateDeps(env, store, "trunk");
		const deps = { gate, invalidate: noInvalidate };
		const t11 = await queuedTask(store, "t11-expired-rate-limit", "t11", { premises: [sessionThrows] });
		const t01 = await queuedTask(store, "t01-null-expired", "t01");
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		await t11.api.breakPremise(VERIFY, { intentId: t01.id, commit: await store.head("trunk"), reason: "assertion no longer holds" }, { assertionId: SESSION_THROWS.id });
		const { raceDeps, starts } = racing(deps, store);
		expect(await startRace(env, { intentId: t11.id, priority: 1, since: Date.now() }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		const intent = await t11.api.get();
		await t11.api.setHead(await store.commit(intent.repo, intent.baseCommit, referencePatch("t11"), "the same work again"));
		const before = await store.head("trunk");
		let reads = 0;
		const never: GateDeps = {
			...gate,
			async snapshot(repo, ref) {
				if (repo === t11.id) {
					reads++;
					throw new Error("ArtifactsError: An internal error occurred.");
				}
				return gate.snapshot(repo, ref);
			},
		};
		const t0 = Date.now();
		const thrown = await landIntent(env, t11.id, "rederive", { ...deps, gate: never }).then(
			(outcome) => `returned ${outcome.kind}`,
			(error: unknown) => `threw: ${error instanceof Error ? error.message : String(error)}`,
		);
		const landMs = Date.now() - t0;
		const statusAfterGate = (await t11.api.get()).status;
		// The gate gives up after its tries and counts a failed re-derive; then the next race.
		expect(await finishRederive(env, t11.id, { landed: false, reason: "The gate could not check this Intent" }, 0)).toBe("stale");
		const race = await startRace(env, { intentId: t11.id, priority: 1, since: Date.now() }, { ...raceDeps, gate: never });
		say("C1 functions", { landIntent: thrown, landMs, readsOfStoppedFork: reads, statusAfterGate, race: race.kind, trunkMoved: (await store.head("trunk")) !== before, agentStarts: starts.map((start) => `${start.attempt}: ${start.reason?.slice(0, 80) ?? ""}`) });
		expect(thrown.startsWith("threw")).toBe(true);
		expect(statusAfterGate).toBe("rederiving");
		expect(race.kind).toBe("rederiving");
		expect(await store.head("trunk")).toBe(before);
		await t11.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("C2: the identical edit next to the landing's change, end to end", () => {
	it("SAFE (break attempt): the stopped work redone on the new trunk, where the landing changed the ADJACENT line of the same file, must not be run and landed", async () => {
		const pair = (limit: number, label: string) => `export const LIMIT: number = ${limit};\nexport const LABEL: string = "${label}";\n`;
		const store = seededStore({ ...demoFiles(), "src/util/pair.ts": pair(1, "one") });
		const deps = { gate: gateDeps(env, store, "trunk"), invalidate: noInvalidate };
		const { raceDeps } = racing(deps, store);
		const limitIsOne: Premise = { symbol: "src/util/pair.ts#LIMIT", source: "asserted", surfaceHash: null, state: "holding", assertion: { id: "a1", description: "LIMIT is 1", code: "assert.eq(LIMIT, 1);", imports: ["src/util/pair.ts"] } };
		// X: changes LABEL (line 2), relying on LIMIT being 1. Its own test only looks at LABEL.
		const id = newIntentId();
		const { head } = await store.fork("trunk", id);
		const testFile = `tests/pair-${id}.test.ts`;
		const test = `import { LABEL } from "../src/util/pair.js";\n\nexport const tests: Record<string, () => void> = {\n\t"the label is upper case": () => {\n\t\tif (LABEL !== "ONE") {\n\t\t\tthrow new Error("not upper case");\n\t\t}\n\t},\n};\n`;
		const api = intentStub(env, id);
		const created = await api.init(newIntent({ id, kind: "agent", taskId: "x98-pair", goal: "Upper-case the label", acceptance: [{ id: "ac1", description: "upper", testFile, testName: "the label is upper case" }], baseCommit: head, premises: [limitIsOne] }));
		await queued(api, store, created, { "src/util/pair.ts": pair(1, "ONE"), [testFile]: test });
		// The landing: LIMIT becomes 2 (line 1, adjacent to X's edit). Pushed to trunk directly here; what matters is trunk's content.
		await store.commit("trunk", await store.head("trunk"), { "src/util/pair.ts": pair(2, "one") }, "LIMIT is now 2");
		const told = await api.breakPremise("src/util/pair.ts#LIMIT", { intentId: "ilander01", commit: await store.head("trunk"), reason: "assertion 'LIMIT is 1' no longer holds after intent ilander01" }, { assertionId: "a1" });
		expect(told).toMatchObject({ broken: true, intent: { status: "stale" } });
		// Race 1: the plain rebase conflicts (adjacent lines), so the work is redone.
		expect(await startRace(env, { intentId: id, priority: 1, since: Date.now() }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		const intent = await api.get();
		expect(intent.stopped?.work).toMatchObject({ repo: id, base: head });
		// The redo: the very same edit, on the new file. Nothing asserted this time.
		await api.setHead(await store.commit(intent.repo, intent.baseCommit, { "src/util/pair.ts": pair(2, "ONE"), [testFile]: test }, "the same edit again"));
		const outcome = await landIntent(env, id, "rederive", deps);
		say("C2 end to end", { gate: outcome.kind, unchanged: outcome.kind !== "skipped" ? (outcome.report.unchanged ?? null) : null, onTrunk: await store.readFile("trunk", "main", "src/util/pair.ts") });
		expect(outcome.kind).toBe("failed");
	}, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("C3: the retried hand-off for a quarantined Intent, and the reordered record-push", () => {
	const body = (symbol: string): Claim => ({ symbol, mode: "body" });
	const withAuditEdit = (): FileChanges => ({ ...referencePatch("t02"), "src/auth/audit.ts": (demoFiles()["src/auth/audit.ts"] ?? "").replace("log.entries.push(entry);", "log.entries.unshift(entry);") });
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
	const cards = async (id: string) => (await hub(env).since(0, 5000)).filter((event) => event.t === "human.needed" && event.id === id).length;

	it("SAFE: an Intent quarantined because ANOTHER Intent holds the symbol stays quarantined however often the hand-off is retried, is never enqueued, and is queued once when the holder is done", async () => {
		const store = seededStore();
		const holder = await startIntent(env, store, "t03-expired-metrics");
		await requestClaimsAcrossShards(env, { intentId: holder.id, claims: [body(RECORD)], priority: 5, dependsOn: [] });
		await holder.api.setClaims([body(RECORD)]);
		const intent = await pushed(store, "t02-audit-expired", [body(LOGIN)], withAuditEdit());
		const enqueued: string[] = [];
		const deps = { store, enqueue: async (item: Intent) => void enqueued.push(item.id) };
		await runChecker(env, intent.id, deps);
		expect((await intent.api.get()).status).toBe("quarantined");
		for (let retry = 0; retry < 3; retry++) {
			await handOff(env, await intent.api.get(), intent.commit, deps);
		}
		const held = { status: (await intent.api.get()).status, enqueued: enqueued.length, cards: await cards(intent.id) };
		// The holder finishes; the retry the wake-up makes (with this test's store).
		await holder.api.act({ a: "fail" }, "abandoned");
		await handOff(env, await intent.api.get(), intent.commit, deps);
		const freed = { status: (await intent.api.get()).status, enqueued: enqueued.length };
		// A late duplicate of the retry, holding the Intent as it was read before (still `quarantined` in that copy).
		await handOff(env, { ...(await intent.api.get()), status: "quarantined" }, intent.commit, deps);
		say("C3 quarantine", { held, freed, afterLateDuplicate: enqueued.length });
		expect(held).toEqual({ status: "quarantined", enqueued: 0, cards: 1 });
		expect(freed).toEqual({ status: "queued", enqueued: 1 });
		expect(enqueued).toHaveLength(1);
		await intent.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("SAFE: record-push when the first attempt was genuinely taken over while the push step ran (stale, re-derive started on a fresh fork): the run stops, records nothing and hands nothing off", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t04-session-ttl-header");
		const fork = `${started.id}-r1`;
		const plain = memorySteps();
		let forkHead = "";
		const steps: typeof plain = {
			...plain,
			async do(name, fn) {
				if (name === "record-push") {
					await started.api.act({ a: "stale" }, "a premise broke");
					await started.api.act({ a: "rederive" });
					await started.api.incRederive();
					forkHead = (await store.fork("trunk", fork)).head;
					await started.api.restartOn(fork, forkHead);
				}
				return plain.do(name, fn);
			},
		};
		const handedOff: string[] = [];
		const deps: AgentDeps = { env, store, intent: started.api, llm: replay(scriptFor("t04-session-ttl-header")), handOff: async (intent) => void handedOff.push(intent.id) };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		const after = await started.api.get();
		say("C3 record-push, taken over", { result: outcome.result, reason: "reason" in outcome ? outcome.reason : null, status: after.status, repo: after.repo === fork ? "the fresh fork" : after.repo, headCommit: after.headCommit, handedOff: handedOff.length, handOffStepRan: plain.names.includes("hand-off") });
		expect(outcome).toMatchObject({ result: "stopped", reason: "the Intent is rederiving" });
		expect(after).toMatchObject({ status: "rederiving", repo: fork, headCommit: null });
		expect(handedOff).toEqual([]);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("SAFE: record-push whose submit was saved and whose answer was lost, and then a premise broke before the retry (the Intent is stale, with this push as its head): the retry does not treat it as 'nothing left to record' and hands nothing off", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t09-currency-format");
		let lose = 1;
		const api = new Proxy(started.api, {
			get(target, property, receiver) {
				if (property !== "act") return Reflect.get(target, property, receiver);
				return async (action: { a: string }, note?: string) => {
					const result = await target.act(action as never, note);
					if (action.a === "submit" && lose > 0) {
						lose--;
						// Between the lost answer and the retry, trunk moves and the Intent goes stale.
						await target.act({ a: "stale" }, "a premise broke");
						throw new Error("Network connection lost.");
					}
					return result;
				};
			},
		}) as IntentApi;
		const runs: Record<string, number> = {};
		const steps = {
			async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
				for (let attemptNo = 0; ; attemptNo++) {
					runs[name] = (runs[name] ?? 0) + 1;
					try {
						const result = await fn();
						return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T;
					} catch (error) {
						if (attemptNo >= 2) throw error;
					}
				}
			},
			async waitForEvent() {
				return null as never;
			},
		};
		const handedOff: string[] = [];
		const deps: AgentDeps = { env, store, intent: api, llm: replay(scriptFor("t09-currency-format")), handOff: async (intent) => void handedOff.push(intent.id) };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		const after = await started.api.get();
		say("C3 record-push, stale between tries", { result: outcome.result, reason: "reason" in outcome ? outcome.reason : null, status: after.status, recordPushRuns: runs["record-push"], handedOff: handedOff.length });
		expect(outcome.result).toBe("stopped");
		expect(after.status).toBe("stale");
		expect(handedOff).toEqual([]);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("C4: a duplicate report that an Intent is stale, at the real Landing object", () => {
	it("SAFE: two reports for the same waiting Intent start one race", async () => {
		await gateIdle();
		await resetDemo(env);
		const intent = await queuedOnTrunk("t04-session-ttl-header", referencePatch("t04"));
		await intent.api.act({ a: "stale" }, "a premise broke");
		const seq = (await hub(env).since(0, 5000)).at(-1)?.seq ?? 0;
		await Promise.all([landing(env).noteStale(intent.id), landing(env).noteStale(intent.id), landing(env).noteStale(intent.id)]);
		const landed = await waitFor(intent.api, ["landed", "escalated", "failed"], 30_000);
		await gateIdle();
		await landing(env).noteStale(intent.id); // and one more, after it has landed
		await gateIdle();
		const events = (await hub(env).since(seq, 5000)).filter(about(intent.id));
		say("C4 waiting duplicates", { status: landed.status, attempts: landed.rederiveAttempts, races: races(events), statusAfterLateReport: (await intent.api.get()).status });
		expect(landed).toMatchObject({ status: "landed", rederiveAttempts: 1 });
		expect(races(events)).toEqual(["pending/pending/-", "pass/pending/rebase"]);
	}, 60_000);

	it("CHARACTERISE: a report for an Intent whose re-derive is RUNNING voids that attempt and starts another; there is never more than one at a time", async () => {
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		await gateIdle();
		await resetDemo(env);
		const t02 = await queuedOnTrunk("t02-audit-expired", referencePatch("t02"), { claims: [{ symbol: LOGIN, mode: "body" }], premises: [sessionThrows] });
		const t01 = await queuedOnTrunk("t01-null-expired", referencePatch("t01"));
		await landing(env).enqueue(t01.id);
		let moved = await t02.api.get();
		for (const deadline = Date.now() + 30_000; moved.repo === t02.id && Date.now() < deadline; moved = await t02.api.get()) {
			await sleep(5);
		}
		const statusWhenReported = moved.status;
		await landing(env).noteStale(t02.id);
		let most = 0;
		let end = await t02.api.get();
		for (const deadline = Date.now() + 60_000; !["landed", "escalated", "failed"].includes(end.status) && Date.now() < deadline; end = await t02.api.get()) {
			most = Math.max(most, (await landing(env).status()).rederiving.filter((entry) => entry.intentId === t02.id).length);
			await sleep(50);
		}
		await gateIdle();
		const events = (await hub(env).since(0, 5000)).filter(about(t02.id));
		say("C4 duplicate while running", { statusWhenReported, end: end.status, attempts: end.rederiveAttempts, repo: end.repo.replace(t02.id, "<id>"), races: races(events), mostRunningAtOnce: most });
		expect(end.status).toBe("landed");
		expect(most).toBeLessThanOrEqual(1);
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete").catch(() => undefined)));
	}, 120_000);
});

// ---------------------------------------------------------------------------------------------------------
describe("C5: an assertion that calls the function through a namespace of the imported file (ordinary path, a model's own style)", () => {
	const namespaceCheck = {
		description: "verifySession returns null for an expired session",
		code: 'import * as session from "src/auth/session.ts";\nimport * as stores from "src/store/memory-store.ts";\nconst store = stores.createMemorySessionStore([{ id: "s1", userId: "u1", expiresAt: 0 }]);\nassert.eq(session.verifySession("s1", store, () => 10), null);',
	};

	it("SAFE (regression check): in a re-derive stopped over verifySession, that assertion answers the redo question", async () => {
		const store = seededStore(demoWith("t01"));
		const started = await startIntent(env, store, "t11-expired-rate-limit");
		const ctx = createToolContext(env, store, started.api, started.id);
		ctx.broken = [{ ...sessionThrows, state: "broken" }];
		const recorded = await callTool(ctx, "assert_premise", namespaceCheck);
		const declared = await callTool(ctx, "declare_changes", { claims: [{ symbol: "src/auth/rate-limit.ts#guardRequest", mode: "body" }], why: ["one"] });
		say("C5 redo question", { recorded: recorded.text.slice(0, 120), recordedError: recorded.isError === true, declared: declared.isError === true ? `REFUSED: ${declared.text.slice(0, 90)}` : "accepted" });
		expect(recorded.isError).toBeUndefined();
		expect(declared).toEqual({ text: "", signal: "claim" });
	}, 60_000);

	it("SAFE (regression check): an Intent that asserted that way and then declares it will change verifySession has the assertion withdrawn (or its own change would break its own premise)", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t01-null-expired");
		const ctx = createToolContext(env, store, started.api, started.id);
		const recorded = await callTool(ctx, "assert_premise", { description: "verifySession throws on expiry", code: 'import * as session from "src/auth/session.ts";\nimport * as stores from "src/store/memory-store.ts";\nconst store = stores.createMemorySessionStore([{ id: "s1", userId: "u1", expiresAt: 0 }]);\nassert.throws(() => session.verifySession("s1", store, () => 10), session.SessionExpiredError);' });
		const declared = await callTool(ctx, "declare_changes", { claims: [{ symbol: VERIFY, mode: "body" }], why: ["change how expiry is reported"] });
		const left = (await started.api.get()).premises.filter((premise) => premise.source === "asserted");
		say("C5 withdraw", { recorded: recorded.text.slice(0, 120), declared: declared.isError === true ? "REFUSED" : "accepted", assertedLeft: left.map((premise) => premise.symbol), withdrawn: ctx.withdrawn });
		expect(recorded.isError).toBeUndefined();
		expect(left).toEqual([]);
	}, 60_000);
});
