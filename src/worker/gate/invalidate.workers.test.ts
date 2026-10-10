import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Intent } from "../../shared/types";
import { type AgentDeps, runAgent } from "../agent/run";
import { hub } from "../hub/publish";
import type { IntentApi } from "../intent/client";
import type { LlmTurn } from "../ports/llm";
import { memorySteps, scriptFor, seededStore, startIntent } from "../testing/agent";
import { demoFiles, referencePatch } from "../testing/demo";
import { invalidate } from "./invalidate";
import { gateDeps, landIntent } from "./land";

type Store = ReturnType<typeof seededStore>;
const VERIFY = "src/auth/session.ts#verifySession";
const THROWS = "verifySession throws SessionExpiredError on expired tokens";

async function waitFor(api: IntentApi, status: Intent["status"], timeoutMs = 10_000): Promise<Intent> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const intent = await api.get();
		if (intent.status === status || Date.now() > deadline) {
			return intent;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/**
 * Runs a task's recorded agent through its plan (reading, asserting, declaring its changes) and
 * then holds it there: status `working`, premises recorded, nothing written yet.
 */
async function frozenInWorking(store: Store, taskId: string) {
	const started = await startIntent(env, store, taskId);
	const turns = scriptFor(taskId);
	const planTurns = turns.findIndex((turn: LlmTurn) => turn.blocks.some((block) => block.type === "tool_use" && block.name === "declare_changes")) + 1;
	let stop: (reason: Error) => void = () => undefined;
	const held = new Promise<LlmTurn>((_, reject) => {
		stop = reject;
	});
	const llm: AgentDeps["llm"] = (_intent, messages) => ({
		turn: async () => {
			const played = messages.filter((message) => message.role === "assistant").length;
			return played < planTurns ? structuredClone(turns[played] as LlmTurn) : held;
		},
	});
	const run = runAgent({ env, store, intent: started.api, llm, handOff: async () => undefined }, { intentId: started.id, mode: "fresh" }, memorySteps());
	const intent = await waitFor(started.api, "working");
	expect(intent.status).toBe("working");
	return {
		...started,
		intent,
		/** Ends the run, then the Intent, which frees its claims for other tests. Returns how the run ended and the status it left. */
		async release() {
			stop(new Error("test over"));
			const outcome = await run;
			const left = (await started.api.get()).status;
			await started.api.act({ a: "fail" }, "test cleanup").catch(() => undefined);
			return { result: outcome.result, left };
		},
	};
}

async function landReference(store: Store, taskId: string, patch: string) {
	const started = await startIntent(env, store, taskId);
	for (const action of [{ a: "claim" }, { a: "granted" }] as const) {
		await started.api.act(action);
	}
	const commit = await store.commit(started.id, started.intent.baseCommit, referencePatch(patch), "work");
	await started.api.act({ a: "submit", commit });
	await started.api.act({ a: "check" });
	await started.api.act({ a: "queue" });
	const outcome = await landIntent(env, started.id, "rebase", { gate: gateDeps(env, store, "trunk") });
	return { ...started, outcome };
}

const eventsAbout = async (id: string): Promise<PremiseEvent[]> => (await hub(env).since(0, 5000)).filter((event) => "id" in event && event.id === id);

describe("invalidation, on the demo scenario", () => {
	it("landing t01 turns t02 and t03 stale on their assertion, and leaves t04 working", async () => {
		const store = seededStore();
		const t02 = await frozenInWorking(store, "t02-audit-expired");
		const t03 = await frozenInWorking(store, "t03-expired-metrics");
		const t04 = await frozenInWorking(store, "t04-session-ttl-header");
		let ends: Awaited<ReturnType<Frozen["release"]>>[] = [];
		try {
			await scenario(store, t02, t03, t04);
		} finally {
			ends = [await t02.release(), await t03.release(), await t04.release()];
		}
		// When their runs end, the stale Intents are not failed: they are waiting to be re-derived and
		// keep their claims for it. The one that was still its run's to work on is failed as before.
		expect(ends).toEqual([
			{ result: "stopped", left: "stale" },
			{ result: "stopped", left: "stale" },
			{ result: "failed", left: "failed" },
		]);
	}, 60_000);

	type Frozen = Awaited<ReturnType<typeof frozenInWorking>>;
	async function scenario(store: Store, t02: Frozen, t03: Frozen, t04: Frozen) {
		// What the agents recorded while planning: t02 and t03 asserted that verifySession throws; t04 did not.
		for (const relying of [t02, t03]) {
			expect(relying.intent.premises.filter((premise) => premise.source === "asserted").map((premise) => [premise.symbol, premise.assertion?.description, premise.state])).toEqual([[VERIFY, THROWS, "holding"]]);
		}
		expect(t04.intent.premises.some((premise) => premise.source === "asserted")).toBe(false);
		expect(t04.intent.premises.length).toBeGreaterThan(0);
		const brokenBefore = (await hub(env).metrics()).premisesBroken;

		// t01 lands: verifySession now returns null on expiry. Its signature is unchanged.
		const t01 = await landReference(store, "t01-null-expired", "t01");
		expect(t01.outcome).toMatchObject({ kind: "landed", changedSymbols: [] });
		const commit = t01.outcome.kind === "landed" ? t01.outcome.commit : "";
		const reason = `assertion '${THROWS}' no longer holds after intent ${t01.id}`;

		for (const relying of [t02, t03]) {
			const after = await relying.api.get();
			expect(after.status).toBe("stale");
			const assertion = after.premises.find((premise) => premise.source === "asserted");
			expect(assertion).toMatchObject({ state: "broken", brokenBy: { intentId: t01.id, commit, reason } });
			// Its type-level premises on the same symbol still hold: the types never changed.
			expect(after.premises.filter((premise) => premise.source !== "asserted").every((premise) => premise.state === "holding")).toBe(true);
			const events = await eventsAbout(relying.id);
			expect(events.filter((event) => event.t === "premise.broken")).toMatchObject([{ symbol: VERIFY, byIntent: t01.id, commit, reason }]);
			expect(events.at(-1)).toMatchObject({ t: "intent.status", status: "stale", note: reason });
		}

		// The control. It read some of the same code and relied on none of the behaviour that changed.
		const control = await t04.api.get();
		expect(control.status).toBe("working");
		expect(control.premises.every((premise) => premise.state === "holding")).toBe(true);
		expect((await eventsAbout(t04.id)).some((event) => event.t === "premise.broken")).toBe(false);

		// The counter the UI shows went up. (Other test files share this event log and may have left
		// Intents in flight that asserted the same thing, so the exact count is checked per Intent above.)
		const brokenAfter = (await hub(env).metrics()).premisesBroken;
		expect(brokenAfter).toBeGreaterThanOrEqual(brokenBefore + 2);
		const metricsEvents = (await hub(env).since(0, 5000)).filter((event) => event.t === "metrics");
		expect(metricsEvents.at(-1)).toMatchObject({ metrics: { premisesBroken: brokenAfter } });
		// The same commit reported again (the platform's push event, say) changes nothing.
		expect(await invalidate(env, { commit, byIntent: t01.id, changedSymbols: [], newTrunkFiles: await store.snapshot("trunk", "main") })).toEqual({ skipped: true, broken: [], intents: [], stale: [] });
		expect((await hub(env).metrics()).premisesBroken).toBe(brokenAfter);
	}

	it("a type-surface change turns its readers stale, including readers of symbols that only mention it", async () => {
		const store = seededStore();
		const session = demoFiles()["src/auth/session.ts"] ?? "";
		const widened = session.replace("export interface Session {", "export interface Session {\n\treadonly note?: string;");
		expect(widened).not.toBe(session);

		// Two Intents at work. One read verifySession, which returns a Session; the other read tax code.
		const reader = await startIntent(env, store, "t04-session-ttl-header");
		const bystander = await startIntent(env, store, "t05-tax-rounding");
		for (const started of [reader, bystander]) {
			await started.api.act({ a: "claim" });
			await started.api.act({ a: "granted" });
		}
		await reader.api.recordPremise({ symbol: VERIFY, source: "observed", surfaceHash: "at-base", state: "holding" });
		await bystander.api.recordPremise({ symbol: "src/billing/tax.ts#taxFor", source: "observed", surfaceHash: "at-base", state: "holding" });

		const lander = await startIntent(env, store, "t12-password-policy", { acceptance: [] });
		for (const action of [{ a: "claim" }, { a: "granted" }] as const) {
			await lander.api.act(action);
		}
		const commit = await store.commit(lander.id, lander.intent.baseCommit, { "src/auth/session.ts": widened }, "widen Session");
		await lander.api.act({ a: "submit", commit });
		await lander.api.act({ a: "check" });
		await lander.api.act({ a: "queue" });
		const outcome = await landIntent(env, lander.id, "rebase", { gate: gateDeps(env, store, "trunk") });
		expect(outcome.kind).toBe("landed");
		expect(outcome.kind === "landed" && outcome.changedSymbols).toEqual(expect.arrayContaining(["src/auth/session.ts#Session", VERIFY]));

		const after = await reader.api.get();
		expect(after.status).toBe("stale");
		expect(after.premises[0]).toMatchObject({ symbol: VERIFY, state: "broken", brokenBy: { intentId: lander.id, reason: `type surface of verifySession changed in intent ${lander.id}` } });
		expect((await bystander.api.get()).status).toBe("working");
		expect((await bystander.api.get()).premises[0]?.state).toBe("holding");

		await reader.api.act({ a: "fail" }, "test cleanup");
		await bystander.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);
});
