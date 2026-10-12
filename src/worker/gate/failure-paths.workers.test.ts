// What the gate and the agent's steps do when a single call fails, with the real compiler, runner and
// Durable Objects. These were written by an independent verifier (2026-10-12) as attempts to break
// claims about the gate, and kept as regression tests. Each asserts the safe behaviour.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newIntentId } from "../../shared/ids";
import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import type { AcceptanceCheck, Assertion, Intent, Premise } from "../../shared/types";
import { handOff } from "../agent/handoff";
import { type AgentDeps, runAgent, type Steps } from "../agent/run";
import { callTool, createToolContext } from "../agent/tools";
import { hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import type { LlmMessage, LlmTurn } from "../ports/llm";
import type { FileChanges, RepoStore } from "../ports/repo-store";
import { memorySteps, replay, scriptFor, seededStore, startIntent } from "../testing/agent";
import { demoFiles, demoWith, referencePatch } from "../testing/demo";
import { type GateDeps, gateOne } from "./gate";
import { type InvalidateDeps, invalidateDeps, invalidateWith, type InvalidateResult } from "./invalidate";
import { gateDeps, type LandEnv, landIntent, landWork } from "./land";
import { finishRederive, type RaceDeps, startRace } from "./rederive";

type Store = ReturnType<typeof seededStore>;
const VERIFY = "src/auth/session.ts#verifySession";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;
const sessionThrows: Premise = { symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS };
const noInvalidate = async (): Promise<InvalidateResult> => ({ skipped: false, broken: [], intents: [], stale: [] });

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
interface Start {
	attempt: number;
	repo: string;
	broken: string[];
	reason?: string;
}
function racing(deps: { gate: GateDeps; invalidate: typeof noInvalidate }, store: Store): { raceDeps: RaceDeps; starts: Start[] } {
	const starts: Start[] = [];
	return {
		starts,
		raceDeps: { ...deps, store, trunk: "trunk", startAgent: async (intent, attempt, broken, reason) => void starts.push({ attempt, repo: intent.repo, broken: broken.map((premise) => `${premise.source}:${premise.symbol}`), ...(reason === undefined ? {} : { reason }) }) },
	};
}

/** t01 has landed. t11 (the old logic, asserting "verifySession throws") had pushed, and is then told its premise broke, exactly as invalidation tells it. */
async function stoppedT11(store: Store) {
	const gate = gateDeps(env, store, "trunk");
	const deps = { gate, invalidate: noInvalidate };
	const t11 = await queuedTask(store, "t11-expired-rate-limit", "t11", { premises: [sessionThrows] });
	const t01 = await queuedTask(store, "t01-null-expired", "t01");
	expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
	const head = await store.head("trunk");
	const told = await t11.api.breakPremise(VERIFY, { intentId: t01.id, commit: head, reason: `assertion '${SESSION_THROWS.description}' no longer holds after intent ${t01.id}` }, { assertionId: SESSION_THROWS.id });
	expect(told.broken).toBe(true);
	expect(told.intent.status).toBe("stale");
	return { deps, t01, t11, c0: told.intent.headCommit as string };
}

/** Everything up to: the redo (same source as the stopped work) has been pushed on the fresh fork. */
async function redoPushed(store: Store) {
	const world = await stoppedT11(store);
	const { raceDeps, starts } = racing(world.deps, store);
	const race1 = await startRace(env, { intentId: world.t11.id, priority: 1, since: Date.now() }, raceDeps);
	expect(race1).toMatchObject({ kind: "rederiving", attempt: 1 });
	const intent = await world.t11.api.get();
	const c1 = await store.commit(intent.repo, intent.baseCommit, referencePatch("t11"), "the same work again");
	await world.t11.api.setHead(c1);
	return { ...world, raceDeps, starts, c1, trunkBefore: await store.head("trunk") };
}
const OLD_LOGIC = referencePatch("t11")["src/auth/rate-limit.ts"];

describe("B1: a redo identical to work stopped over an asserted premise", () => {
	it("B1-a. full sequence with the real startRace: turned back unrun, no way in as a rebase on the next race, nor after trunk moves, nor after a person's Retry", async () => {
		const store = seededStore();
		const { deps, t11, c0, raceDeps, starts, trunkBefore } = await redoPushed(store);
		let intent = await t11.api.get();
		expect(intent.stopped?.work).toMatchObject({ repo: t11.id, commit: c0 });
		expect(intent.stopped?.over.map((premise) => premise.symbol)).toEqual([VERIFY]);
		expect(starts[0]?.broken).toEqual([`asserted:${VERIFY}`]);

		// Control: nothing else at the gate would stop this commit. Every check passes.
		const dry = await gateOne(deps.gate, intent, "rederive", { dryRun: true });
		expect(dry.report.ok).toBe(true);

		const turned1 = await landIntent(env, t11.id, "rederive", deps);
		expect(turned1.kind).toBe("failed");
		if (turned1.kind !== "failed") throw new Error("unreachable");
		expect(turned1.report.unchanged).toEqual(["src/auth/rate-limit.ts"]);
		expect(turned1.report.durationMs).toBe(0);
		expect(await store.head("trunk")).toBe(trunkBefore);
		expect(await finishRederive(env, t11.id, { landed: false, reason: turned1.note }, 0)).toBe("stale");

		// The next race, entered as the Landing object enters it after a failed re-derive (a reason, no rebaseFailedAt).
		const race2 = await startRace(env, { intentId: t11.id, priority: 1, since: Date.now(), reason: turned1.note }, raceDeps);
		expect(race2).toMatchObject({ kind: "rederiving", attempt: 2 });
		expect(await store.head("trunk")).toBe(trunkBefore);
		// "The redo rule is asked again on later attempts": the agent is told the same premises again.
		expect(starts[1]?.broken).toEqual([`asserted:${VERIFY}`]);

		// Attempt 2 is the same again, and meanwhile trunk moves (an unrelated landing).
		intent = await t11.api.get();
		await t11.api.setHead(await store.commit(intent.repo, intent.baseCommit, referencePatch("t11"), "the same work a third time"));
		const t04 = await queuedTask(store, "t04-session-ttl-header", "t04");
		expect((await landIntent(env, t04.id, "rebase", deps)).kind).toBe("landed");
		const afterT04 = await store.head("trunk");
		const turned2 = await landIntent(env, t11.id, "rederive", deps);
		expect(turned2.kind).toBe("failed");
		expect(turned2.kind === "failed" ? turned2.report.unchanged : null).toEqual(["src/auth/rate-limit.ts"]);
		expect(await finishRederive(env, t11.id, { landed: false, reason: "same" }, 1)).toBe("escalated");

		// A person says Retry: the status goes straight to `rederiving`, and the race runs with no entry reason.
		await t11.api.act({ a: "human", choice: "Retry" });
		const race3 = await startRace(env, { intentId: t11.id, priority: 1, since: Date.now() }, raceDeps);
		expect(race3).toMatchObject({ kind: "rederiving", attempt: 3 });
		expect(await store.head("trunk")).toBe(afterT04);
		expect(await store.readFile("trunk", "main", "src/auth/rate-limit.ts")).not.toBe(OLD_LOGIC);
		await t11.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("B1-b. the redo is pushed and the Intent goes stale again BEFORE the gate has looked at it: the race must not land it as a rebase", async () => {
		const store = seededStore();
		const { t11, raceDeps, trunkBefore } = await redoPushed(store);
		await t11.api.act({ a: "stale" }, "trunk moved under the re-derive");
		const race = await startRace(env, { intentId: t11.id, priority: 1, since: Date.now() }, raceDeps);
		expect(race.kind).toBe("rederiving");
		expect(await store.head("trunk")).toBe(trunkBefore);
		await t11.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	/** The same gate, except that the next `times` reads of `repo` fail, as a remote repo store does now and then. */
	function withFailedRead(gate: GateDeps, repo: string, times = 1): GateDeps & { failed(): number } {
		let left = times;
		let failed = 0;
		return {
			...gate,
			async snapshot(name, ref) {
				if (name === repo && left > 0) {
					left--;
					failed++;
					throw new Error("ArtifactsError: An internal error occurred.");
				}
				return gate.snapshot(name, ref);
			},
			failed: () => failed,
		};
	}

	it("B1-c. BREAK ATTEMPT: after the gate turned the redo back, ONE read of the stopped fork fails while the next race decides whether to rebase. The turned-back commit must still not reach trunk", async () => {
		const store = seededStore();
		const { deps, t11, raceDeps, trunkBefore } = await redoPushed(store);
		const turned = await landIntent(env, t11.id, "rederive", deps);
		expect(turned.kind).toBe("failed");
		expect(turned.kind === "failed" ? turned.report.unchanged : null).toEqual(["src/auth/rate-limit.ts"]);
		expect(await finishRederive(env, t11.id, { landed: false, reason: turned.kind === "failed" ? turned.note : "" }, 0)).toBe("stale");

		const flaky = withFailedRead(deps.gate, t11.id, 1);
		const race = await startRace(env, { intentId: t11.id, priority: 1, since: Date.now(), reason: turned.kind === "failed" ? turned.note : null }, { ...raceDeps, gate: flaky });
		const onTrunk = (await store.readFile("trunk", "main", "src/auth/rate-limit.ts")) === OLD_LOGIC;
		expect(flaky.failed()).toBe(1);
		expect(race.kind).not.toBe("landed");
		expect(onTrunk).toBe(false);
	}, 60_000);

	it("B1-d. BREAK ATTEMPT: ONE read of the stopped fork fails while the gate itself looks at the redo (path rederive). It must not be run and landed", async () => {
		const store = seededStore();
		const { deps, t11, trunkBefore } = await redoPushed(store);
		const flaky = withFailedRead(deps.gate, t11.id, 1);
		const outcome = await landIntent(env, t11.id, "rederive", { ...deps, gate: flaky });
		const onTrunk = (await store.readFile("trunk", "main", "src/auth/rate-limit.ts")) === OLD_LOGIC;
		expect(flaky.failed()).toBe(1);
		expect(outcome.kind).not.toBe("landed");
		expect(onTrunk).toBe(false);
	}, 60_000);
});
const race1Kind = (race: { kind: string }) => race.kind;

// ---- B2 ----
const FLAG_OFF = "export const FLAG: boolean = false;\n";
const FLAG_ON = "export const FLAG: boolean = true;\n";
const flagStore = () => seededStore({ ...demoFiles(), "src/util/flag.ts": FLAG_OFF });
const work = (id: string, value: number): FileChanges => ({
	[`src/util/w_${id}.ts`]: `export const W: number = ${value};\n`,
	[`tests/w-${id}.test.ts`]: `import { FLAG } from "../src/util/flag.js";\nimport { W } from "../src/util/w_${id}.js";\n\nexport const tests: Record<string, () => void> = {\n\t"works once the flag is on": () => {\n\t\tif (!FLAG || W < 1) {\n\t\t\tthrow new Error("the flag is off");\n\t\t}\n\t},\n};\n`,
});
/** An agent Intent (not one of the demo tasks, so no reference checks) whose own test only passes once trunk turns FLAG on. */
async function flagIntent(store: Store, value: number, fields: Partial<Intent> = {}) {
	const id = newIntentId();
	const { head } = await store.fork("trunk", id);
	const acceptance: AcceptanceCheck[] = [{ id: "ac1", description: "works once the flag is on", testFile: `tests/w-${id}.test.ts`, testName: "works once the flag is on" }];
	const api = intentStub(env, id);
	const intent = await api.init(newIntent({ id, kind: "agent", taskId: "x99-flag", goal: `Add W for ${id}`, acceptance, baseCommit: head, ...fields }));
	return { id, api, intent: await queued(api, store, intent, work(id, value)) };
}
const flagOn = async (store: Store) => store.commit("trunk", await store.head("trunk"), { "src/util/flag.ts": FLAG_ON }, "turn the flag on");

/** Attempt N pushes `value` on the current fork, the gate looks at it, and the result is returned. */
async function attempt(store: Store, x: { id: string; api: IntentApi }, value: number, deps: { gate: GateDeps; invalidate: typeof noInvalidate }, message: string) {
	const intent = await x.api.get();
	await x.api.setHead(await store.commit(intent.repo, intent.baseCommit, work(x.id, value), message));
	return landIntent(env, x.id, "rederive", deps);
}

describe("B2: the same re-derive is NOT turned back when the work was not stopped over an asserted premise", () => {
	it("B2-a. surface-only break: attempt 1 byte-identical to the stopped work is RUN (and fails on its own test); attempt 2 byte-identical to attempt 1 lands once trunk allows it", async () => {
		const store = flagStore();
		const deps = { gate: gateDeps(env, store, "trunk"), invalidate: noInvalidate };
		const { raceDeps, starts } = racing(deps, store);
		const x = await flagIntent(store, 1);
		await x.api.recordPremises([{ symbol: VERIFY, source: "observed", surfaceHash: "h-old", state: "holding" }]);
		const told = await x.api.breakPremise(VERIFY, { intentId: "ilander01", commit: "c".repeat(40), reason: "type surface of verifySession changed in intent ilander01" }, { sources: ["observed", "derived"] });
		expect(told).toMatchObject({ broken: true, intent: { status: "stale" } });

		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now() }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		expect((await x.api.get()).stopped).toBeUndefined();
		const first = await attempt(store, x, 1, deps, "attempt 1: the same files");
		expect(first.kind).toBe("failed");
		if (first.kind !== "failed") throw new Error("unreachable");
		expect(first.report.unchanged).toBeUndefined();
		expect(first.report.tests.failed.map((failure) => failure.name)).toEqual(["works once the flag is on"]);
		expect(await finishRederive(env, x.id, { landed: false, reason: first.note }, 0)).toBe("stale");
		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now(), reason: first.note }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 2 });
		await flagOn(store);
		const second = await attempt(store, x, 1, deps, "attempt 2: the same files again");
		expect(second.kind).toBe("landed");
		expect(second.kind === "landed" ? second.report.unchanged : "x").toBeUndefined();
	}, 60_000);

	it("B2-b. a first attempt the gate simply rejected (no premise involved): the identical redo, twice, is run each time and lands once trunk allows it", async () => {
		const store = flagStore();
		const deps = { gate: gateDeps(env, store, "trunk"), invalidate: noInvalidate };
		const { raceDeps } = racing(deps, store);
		const x = await flagIntent(store, 1);
		const rejected = await landIntent(env, x.id, "rebase", deps);
		expect(rejected.kind).toBe("stale");
		if (rejected.kind !== "stale") throw new Error("unreachable");
		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now(), rebaseFailedAt: rejected.trunkAt, reason: rejected.note }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		expect((await x.api.get()).stopped).toBeUndefined();
		const first = await attempt(store, x, 1, deps, "attempt 1: the same files");
		expect(first.kind).toBe("failed");
		expect(first.kind === "failed" ? first.report.unchanged : "x").toBeUndefined();
		expect(await finishRederive(env, x.id, { landed: false, reason: "failed its test" }, 0)).toBe("stale");
		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now(), reason: "failed its test" }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 2 });
		await flagOn(store);
		const second = await attempt(store, x, 1, deps, "attempt 2: the same files again");
		expect(second.kind).toBe("landed");
	}, 60_000);

	it("B2-c. stopped over an ASSERTED premise with work A; attempt 1 is different work B and fails the gate; attempt 2 byte-identical to attempt 1 is not turned back and lands", async () => {
		const store = flagStore();
		const deps = { gate: gateDeps(env, store, "trunk"), invalidate: noInvalidate };
		const { raceDeps } = racing(deps, store);
		const x = await flagIntent(store, 1, { premises: [sessionThrows] });
		const t01 = await queuedTask(store, "t01-null-expired", "t01");
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		const told = await x.api.breakPremise(VERIFY, { intentId: t01.id, commit: await store.head("trunk"), reason: "assertion no longer holds" }, { assertionId: SESSION_THROWS.id });
		expect(told).toMatchObject({ broken: true, intent: { status: "stale" } });
		const c0 = told.intent.headCommit;
		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now() }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		expect((await x.api.get()).stopped?.work).toMatchObject({ repo: x.id, commit: c0 });

		const first = await attempt(store, x, 2, deps, "attempt 1: different work");
		expect(first.kind).toBe("failed");
		expect(first.kind === "failed" ? first.report.unchanged : "x").toBeUndefined();
		expect(await finishRederive(env, x.id, { landed: false, reason: "failed its test" }, 0)).toBe("stale");
		expect(await startRace(env, { intentId: x.id, priority: 1, since: Date.now(), reason: "failed its test" }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 2 });
		// What it is compared with is still the work that was stopped, not the attempt before.
		expect((await x.api.get()).stopped?.work).toMatchObject({ repo: x.id, commit: c0 });
		await flagOn(store);
		const second = await attempt(store, x, 2, deps, "attempt 2: the same as attempt 1");
		expect(second.kind).toBe("landed");
		expect(second.kind === "landed" ? second.report.unchanged : "x").toBeUndefined();

		// And the counterpart, on the same store: work A again WOULD be turned back for this Intent's twin.
		const y = await flagIntent(store, 1, { premises: [sessionThrows] });
		await y.api.breakPremise(VERIFY, { intentId: t01.id, commit: await store.head("trunk"), reason: "assertion no longer holds" }, { assertionId: SESSION_THROWS.id });
		expect(await startRace(env, { intentId: y.id, priority: 1, since: Date.now() }, raceDeps)).toMatchObject({ kind: "rederiving", attempt: 1 });
		const again = await attempt(store, y, 1, deps, "the stopped work again");
		expect(again.kind).toBe("failed");
		expect(again.kind === "failed" ? again.report.unchanged : null).toEqual([`src/util/w_${y.id}.ts`]);
		await y.api.act({ a: "fail" }, "test cleanup");
	}, 90_000);
});

// ---- B4 ----
/** Steps as workflow.ts configures them: a step that throws is run again, up to two more times. */
function retryingSteps(before?: (name: string, run: number) => Promise<void>): Steps & { runs: Record<string, number> } {
	const runs: Record<string, number> = {};
	return {
		runs,
		async do(name, fn) {
			for (let attemptNo = 0; ; attemptNo++) {
				runs[name] = (runs[name] ?? 0) + 1;
				try {
					await before?.(name, runs[name] as number);
					const result = await fn();
					return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as never;
				} catch (error) {
					if (attemptNo >= 2) throw error;
				}
			}
		},
		async waitForEvent() {
			return null as never;
		},
	};
}

describe("B4: steps after the push, retried", () => {
	it("B4-a. record-push: the submit is SAVED in the Intent and then the call fails once (as when the status is stored and the event that follows cannot be published). The retry must carry on to the checker and the gate", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t09-currency-format");
		let lose = 1;
		// The Intent's API, except that the first `submit` is applied and then reported as failed.
		const api = new Proxy(started.api, {
			get(target, property, receiver) {
				if (property !== "act") return Reflect.get(target, property, receiver);
				return async (action: { a: string }, note?: string) => {
					const result = await target.act(action as never, note);
					if (action.a === "submit" && lose > 0) {
						lose--;
						throw new Error("Network connection lost.");
					}
					return result;
				};
			},
		}) as IntentApi;
		const enqueued: string[] = [];
		const steps = retryingSteps();
		const deps: AgentDeps = { env, store, intent: api, llm: replay(scriptFor("t09-currency-format")), handOff: (intent, commit) => handOff(env, intent, commit, { store, enqueue: async (item) => void enqueued.push(item.id) }) };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		const intent = await started.api.get();
		await started.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
		expect(lose).toBe(0);
		expect(outcome.result).toBe("submitted");
		expect(intent.status).toBe("queued");
		expect(enqueued).toEqual([started.id]);
	}, 60_000);

	it("B4-b. the checker quarantines an out-of-claim push and then fails once (publishing the ledger's answer). The retry must not leave the Intent quarantined with nothing to move it on", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t09-currency-format");
		// The hub, except that the first `claim.decision` for this Intent cannot be published.
		let lose = 1;
		const flakyEnv = {
			INTENT: env.INTENT,
			LEDGER: env.LEDGER,
			AGENT_WORKFLOW: env.AGENT_WORKFLOW,
			REPO_STORE: env.REPO_STORE,
			TRUNK_REPO: env.TRUNK_REPO,
			LANDING: env.LANDING,
			LOADER: env.LOADER,
			HUB: {
				idFromName: (name: string) => env.HUB.idFromName(name),
				get: (id: DurableObjectId) => {
					const stub = env.HUB.get(id) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
					return new Proxy({}, {
						get: (_target, property: string) => {
							if (property === "then") return undefined;
							if (property === "publish") {
								return async (body: PremiseEventBody) => {
									if (body.t === "claim.decision" && body.id === started.id && lose > 0) {
										lose--;
										throw new Error("hub unavailable");
									}
									return (stub.publish as (b: PremiseEventBody) => Promise<unknown>)(body);
								};
							}
							return (...args: unknown[]) => (stub[property] as (...inner: unknown[]) => Promise<unknown>)(...args);
						},
					});
				},
			},
		} as unknown as typeof env;
		const enqueued: string[] = [];
		// Just before the hand-off the Intent's recorded claims are emptied, so the checker finds its push out of claim.
		const steps = retryingSteps(async (name, run) => {
			if (name === "hand-off" && run === 1) await started.api.setClaims([]);
		});
		const deps: AgentDeps = { env, store, intent: started.api, llm: replay(scriptFor("t09-currency-format")), handOff: (intent, commit) => handOff(flakyEnv, intent, commit, { store, enqueue: async (item) => void enqueued.push(item.id) }) };
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		const intent = await started.api.get();
		const events = (await hub(env).since(0, 5000)).filter((event: PremiseEvent) => "id" in event && event.id === started.id);
		await started.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
		expect(lose).toBe(0);
		expect(intent.status).toBe("queued");
		expect(enqueued).toEqual([started.id]);
	}, 60_000);
});

// ---- B5 / B6 ----
describe("B5: assert_premise and the symbol an agent names", () => {
	const tax = { description: "tax is rounded half up", code: "assert.eq(taxFor(105, 1000), 11);", imports: ["src/billing/tax.ts"] };
	async function setup() {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		const ctx = createToolContext(env, store, started.api, started.id);
		return { ...started, call: (name: string, input: Record<string, unknown> = {}) => callTool(ctx, name, input) };
	}
	const assertedOf = async (api: IntentApi) => (await api.get()).premises.filter((premise) => premise.source === "asserted");

	it("B5-a. malformed ids, a symbol that does not exist, one in a file the check does not import, one it imports but never names: all refused, nothing recorded (also for an adopted assertion)", async () => {
		const { call, api } = await setup();
		const refusals: Record<string, string> = {};
		for (const symbol of ["src/billing/tax.ts", "#taxFor", "src/billing/tax.ts#", "src/billing/tax.ts#taxFor#x", "taxFor", "src/billing/tax.ts#noSuchThing", "src/nope.ts#taxFor", VERIFY, "src/billing/tax.ts#TaxLine", "./src/billing/tax.ts#taxFor"]) {
			const result = await call("assert_premise", { ...tax, symbol });
			refusals[symbol] = `${result.isError === true ? "REFUSED" : "ACCEPTED"}: ${result.text.slice(0, 70)}`;
		}
		// imported but not named in the code
		const unnamed = await call("assert_premise", { ...tax, imports: ["src/billing/tax.ts", "src/auth/session.ts"], symbol: VERIFY });
		refusals[`${VERIFY} (imported, not named)`] = `${unnamed.isError === true ? "REFUSED" : "ACCEPTED"}: ${unnamed.text.slice(0, 70)}`;
		const adopted = await call("assert_premise", { adopt: "a-session-throws", symbol: "src/billing/tax.ts#taxFor" });
		refusals["adopt a-session-throws as src/billing/tax.ts#taxFor"] = `${adopted.isError === true ? "REFUSED" : "ACCEPTED"}: ${adopted.text.slice(0, 70)}`;
		const adoptedBad = await call("assert_premise", { adopt: "a-session-throws", symbol: "not a symbol" });
		refusals["adopt a-session-throws as 'not a symbol'"] = `${adoptedBad.isError === true ? "REFUSED" : "ACCEPTED"}: ${adoptedBad.text.slice(0, 70)}`;
		expect(Object.values(refusals).every((verdict) => verdict.startsWith("REFUSED"))).toBe(true);
		expect(await assertedOf(api)).toEqual([]);
		// And the good one is still accepted.
		expect((await call("assert_premise", { ...tax, symbol: "src/billing/tax.ts#taxFor" })).isError).toBeUndefined();
	}, 60_000);

	it("B5-b. a check that exercises taxFor and names verifySession only in a COMMENT should not be filed under verifySession", async () => {
		const { call, api } = await setup();
		const result = await call("assert_premise", { description: "tax is rounded half up", code: "assert.eq(taxFor(105, 1000), 11); // verifySession", imports: ["src/billing/tax.ts", "src/auth/session.ts"], symbol: VERIFY });
		expect(result.isError).toBe(true);
		expect(await assertedOf(api)).toEqual([]);
	}, 60_000);
});

describe("B6: the redo question reaches a real re-derive run", () => {
	it("B6-a. runAgent in re-derive mode, given the broken premise as startRace gives it: declare_changes with no_behaviour is refused with the redo question, then accepted once verifySession is asserted about", async () => {
		const store = seededStore(demoWith("t01"));
		const started = await startIntent(env, store, "t11-expired-rate-limit");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await started.api.act(action);
		}
		const attemptNo = (await started.api.incRederive()).rederiveAttempts;
		const fork = `${started.id}-r${attemptNo}`;
		const { head } = await store.fork("trunk", fork);
		await started.api.restartOn(fork, head);
		const broken: Premise[] = [{ ...sessionThrows, state: "broken", brokenBy: { intentId: "ilander01", commit: "c".repeat(40), reason: "assertion no longer holds" } }];
		const guard = [{ symbol: "src/auth/rate-limit.ts#guardRequest", mode: "body" }];
		const use = (id: string, name: string, input: Record<string, unknown>): LlmTurn => ({ blocks: [{ type: "tool_use", id, name, input }], stop: "tool_use", usage: { input: 1, output: 1 } });
		const script: LlmTurn[] = [
			use("u1", "declare_changes", { claims: guard, why: ["as before"], no_behaviour: true }),
			use("u2", "assert_premise", { description: "tax", code: "assert.eq(taxFor(105, 1000), 11);", imports: ["src/billing/tax.ts"] }),
			use("u3", "declare_changes", { claims: guard, why: ["as before"] }),
			use("u4", "assert_premise", { description: "verifySession returns null for an expired session", code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.eq(verifySession('s1', store, () => 10), null);", imports: ["src/store/memory-store.ts", "src/auth/session.ts"] }),
			use("u5", "declare_changes", { claims: guard, why: ["as before"] }),
		];
		const seen: LlmMessage[][] = [];
		let turnNo = 0;
		const deps: AgentDeps = {
			env,
			store,
			intent: started.api,
			llm: () => ({
				turn: async (_system, messages) => {
					seen.push([...messages]);
					const next = script[turnNo++];
					if (next === undefined) throw new Error("end of the verifier's script");
					return next;
				},
			}),
			handOff: async () => undefined,
			giveUp: async () => undefined,
		};
		await runAgent(deps, { intentId: started.id, mode: "rederive", attempt: attemptNo, broken }, memorySteps());
		const resultOf = (id: string) => seen.flatMap((messages) => messages).flatMap((message) => (message.role === "user" && Array.isArray(message.content) ? message.content : [])).find((block) => block.tool_use_id === id);
		const answers = ["u1", "u2", "u3", "u4", "u5"].map((id) => ({ id, error: resultOf(id)?.is_error === true, text: (resultOf(id)?.content ?? "").slice(0, 400) }));
		expect(answers[0]).toMatchObject({ error: true, text: expect.stringContaining("Your earlier work was stopped because what it relied on about src/auth/session.ts#verifySession") });
		expect(answers[2]).toMatchObject({ error: true, text: expect.stringContaining("Your earlier work was stopped") });
		expect(answers[3]?.error).toBe(false);
		// u5 ends the plan phase: the ledger's answer becomes its result.
		expect(answers[4]).toMatchObject({ error: false, text: expect.stringContaining("Granted") });
		expect((await started.api.get()).claims).toEqual(guard);
		await started.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
	}, 60_000);
});

// ---- B7 ----
/** The environment landWork is given, with chosen calls made to fail. */
function failing(options: { land?: number; publish?: (body: PremiseEventBody) => boolean }) {
	const seen = { landTries: 0, publishFailures: [] as string[] };
	const INTENT = {
		idFromName: (name: string) => env.INTENT.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = env.INTENT.get(id) as unknown as { rpc(method: string, args: unknown[]): Promise<unknown> };
			return {
				rpc: async (method: string, args: unknown[]) => {
					if (method === "act" && (args[0] as { a?: string } | undefined)?.a === "land") {
						seen.landTries++;
						if (seen.landTries <= (options.land ?? 0)) {
							throw new Error("Durable Object reset because its code was updated.");
						}
					}
					return stub.rpc(method, args);
				},
			};
		},
	};
	const HUB = {
		idFromName: (name: string) => env.HUB.idFromName(name),
		get: (id: DurableObjectId) => {
			const stub = env.HUB.get(id) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
			return new Proxy({}, {
				get: (_target, property: string) => {
					if (property === "then") return undefined;
					if (property === "publish") {
						return async (body: PremiseEventBody) => {
							if (options.publish?.(body)) {
								seen.publishFailures.push(body.t);
								throw new Error("hub unavailable");
							}
							return (stub.publish as (b: PremiseEventBody) => Promise<unknown>)(body);
						};
					}
					return (...args: unknown[]) => (stub[property] as (...inner: unknown[]) => Promise<unknown>)(...args);
				},
			});
		},
	};
	return { env: { HUB, INTENT, LEDGER: env.LEDGER, LOADER: env.LOADER } as unknown as LandEnv, seen };
}
async function gatingT04(store: Store) {
	const t04 = await queuedTask(store, "t04-session-ttl-header", "t04");
	return { ...t04, intent: await t04.api.act({ a: "gate" }) };
}
const eventsAbout = async (id: string) => (await hub(env).since(0, 5000)).filter((event) => ("id" in event && event.id === id) || (event.t === "trunk.advanced" && event.byIntent === id) || (event.t === "artifacts" && (event.detail as { intent?: string }).intent === id));

describe("B7: after the work is on trunk, one failed follow-up step does not skip the rest (landWork)", () => {
	it("B7-a. marking the Intent landed fails on every try: the push is still reported, trunk.advanced still published, invalidation still run and its stale list returned", async () => {
		const store = seededStore();
		const t04 = await gatingT04(store);
		const flaky = failing({ land: 99 });
		const invalidated: string[] = [];
		const outcome = await landWork(flaky.env, t04.intent, "rebase", { gate: gateDeps(env, store, "trunk"), invalidate: async (_env, landed) => (invalidated.push(landed.commit), { skipped: false, broken: [], intents: ["iother001"], stale: ["iother001"] }) });
		const head = await store.head("trunk");
		const events = await eventsAbout(t04.id);
		const status = (await t04.api.get()).status;
		expect(outcome).toMatchObject({ kind: "landed", commit: head, stale: ["iother001"] });
		expect(flaky.seen.landTries).toBe(3);
		expect(invalidated).toEqual([head]);
		expect(events.filter((event) => event.t === "trunk.advanced")).toHaveLength(1);
		await t04.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
	}, 60_000);

	it("B7-b. marking it landed fails once: the second try marks it; trunk.advanced cannot be published on any try: invalidation still runs", async () => {
		const store = seededStore();
		const t04 = await gatingT04(store);
		const flaky = failing({ land: 1, publish: (body) => body.t === "trunk.advanced" });
		const invalidated: string[] = [];
		const outcome = await landWork(flaky.env, t04.intent, "rebase", { gate: gateDeps(env, store, "trunk"), invalidate: async (_env, landed) => (invalidated.push(landed.commit), { skipped: false, broken: [], intents: ["iother001"], stale: ["iother001"] }) });
		expect(outcome).toMatchObject({ kind: "landed", stale: ["iother001"] });
		expect((await t04.api.get()).status).toBe("landed");
		expect(flaky.seen.publishFailures).toEqual(["trunk.advanced", "trunk.advanced", "trunk.advanced"]);
		expect(invalidated).toHaveLength(1);
	}, 60_000);

	it("B7-c. invalidation itself throws: the landing is still reported as landed (with nobody listed as stale)", async () => {
		const store = seededStore();
		const t04 = await gatingT04(store);
		const outcome = await landWork(failing({}).env, t04.intent, "rebase", {
			gate: gateDeps(env, store, "trunk"),
			invalidate: async () => {
				throw new Error("the ledger could not be read");
			},
		});
		expect(outcome).toMatchObject({ kind: "landed", stale: [] });
		expect((await t04.api.get()).status).toBe("landed");
	}, 60_000);

	it("B7-d. invalidateWith against the REAL Intent objects: telling one Intent succeeds but its answer is lost once. Every Intent this call turned stale must be in the result", async () => {
		const store = seededStore();
		const a = await queuedTask(store, "t02-audit-expired", "t02", { premises: [sessionThrows] });
		const b = await queuedTask(store, "t03-expired-metrics", "t03", { premises: [sessionThrows] });
		const real = invalidateDeps(env);
		let lose = 1;
		const deps: InvalidateDeps = {
			claimCommit: async () => true,
			registry: async () => [
				{ id: a.id, status: "queued" },
				{ id: b.id, status: "queued" },
			],
			readersOf: async () => [],
			asserters: async () => [a.id, b.id],
			getIntent: real.getIntent,
			async breakPremise(id, symbol, by, scope) {
				const result = await real.breakPremise(id, symbol, by, scope);
				if (id === a.id && lose > 0) {
					lose--;
					throw new Error("Network connection lost.");
				}
				return result;
			},
			run: real.run,
			publishMetrics: async () => undefined,
		};
		const result = await invalidateWith(deps, { commit: "d".repeat(40), byIntent: "ilander01", changedSymbols: [], newTrunkFiles: demoWith("t01") });
		const statuses = { a: (await a.api.get()).status, b: (await b.api.get()).status };
		expect(statuses).toEqual({ a: "stale", b: "stale" });
		expect(result.stale.sort()).toEqual([a.id, b.id].sort());
		await a.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
		await b.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
	}, 60_000);
});

// ---- B7, batch landings ----
import { landBatch } from "./land";

describe("B7: the same rule for a batch landing (landBatch, the way scripted workload Intents land)", () => {
	async function workloadQueued(store: Store, n: number) {
		const id = newIntentId();
		const { head } = await store.fork("trunk", id);
		const api = intentStub(env, id);
		const intent = await api.init(newIntent({ id, kind: "workload", taskId: `w${n}-scripted`, goal: `scripted edit ${n}`, acceptance: [], baseCommit: head }));
		return { id, api, intent: await queued(api, store, intent, { [`src/util/wl_${id}.ts`]: `export const V${n}: number = ${n};\n` }) };
	}

	it("B7-e. two workload Intents land as one commit; marking the first of them landed fails once. trunk.advanced and invalidation for that commit must still happen", async () => {
		const store = seededStore();
		const a = await workloadQueued(store, 1);
		const b = await workloadQueued(store, 2);
		const before = await store.head("trunk");
		const flaky = failing({ land: 1 });
		const invalidated: string[] = [];
		const deps = { gate: gateDeps(env, store, "trunk"), invalidate: async (_env: unknown, landed: { commit: string }) => (invalidated.push(landed.commit), { skipped: false, broken: [], intents: [], stale: [] }) };
		let threw: string | null = null;
		let batch: Awaited<ReturnType<typeof landBatch>> | null = null;
		try {
			batch = await landBatch(flaky.env, [a.id, b.id], deps);
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		const after = await store.head("trunk");
		// What the Landing object does when landBatch throws: each member gets a gate run of its own.
		const singly = threw === null ? [] : [await landIntent(flaky.env, a.id, "rebase", deps), await landIntent(flaky.env, b.id, "rebase", deps)];
		const all = await hub(env).since(0, 5000);
		const advanced = all.filter((event) => event.t === "trunk.advanced" && (event.byIntent === a.id || event.byIntent === b.id)).length;
		expect(after).not.toBe(before); // the work is on trunk
		expect(advanced).toBe(1);
		expect(invalidated).toEqual([after]);
	}, 60_000);
});
