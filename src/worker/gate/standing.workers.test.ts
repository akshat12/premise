import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import { newIntentId } from "../../shared/ids";
import type { Assertion, Intent, Premise } from "../../shared/types";
import { briefing } from "../agent/prompts";
import { createToolContext, runChecks } from "../agent/tools";
import { resetDemo } from "../dispatch";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { getRepoStore } from "../ports";
import type { FileChanges, RepoStore } from "../ports/repo-store";
import { demoTask, seededStore, startIntent } from "../testing/agent";
import { demoFiles, demoWith, referencePatch } from "../testing/demo";
import { landing } from "./client";
import { gateDeps, landIntent } from "./land";
import { MemoryStandingStore } from "./standing";

const VERIFY = "src/auth/session.ts#verifySession";
const SESSION_THROWS = (JSON.parse(demoFiles()["premise/assertions.json"] ?? "[]") as Assertion[])[0] as Assertion;
const sessionThrows: Premise = { symbol: VERIFY, source: "asserted", surfaceHash: null, state: "holding", assertion: SESSION_THROWS };
const EXPIRED_TEST = "an expired session writes an audit entry and returns expired";

async function toQueued(api: IntentApi, store: RepoStore, intent: Intent, changes: FileChanges): Promise<void> {
	await api.act({ a: "claim" });
	await api.act({ a: "granted" });
	const commit = await store.commit(intent.repo, intent.baseCommit, changes, "work");
	await api.act({ a: "submit", commit });
	await api.act({ a: "check" });
	await api.act({ a: "queue" });
}

const eventsAbout = async (id: string): Promise<PremiseEvent[]> => (await hub(env).since(0, 5000)).filter((event) => ("id" in event && event.id === id) || (event.t === "gate.result" && event.report.intentId === id));

describe("standing checks at the gate (real compiler and runner)", () => {
	async function world() {
		const store = seededStore();
		const standing = new MemoryStandingStore();
		const deps = { gate: gateDeps(env, store, "trunk"), standing };
		async function queued(taskId: string, changes: FileChanges, fields: Partial<Intent> = {}) {
			const started = await startIntent(env, store, taskId, fields);
			await toQueued(started.api, store, started.intent, changes);
			return started;
		}
		return { store, standing, deps, queued };
	}

	it("the order the demo cannot control: t02 lands first, and t01 can no longer break it silently", async () => {
		const { store, standing, deps, queued } = await world();
		// Both written against the original trunk. This time the Intent that relies on the throw lands first.
		const t02 = await queued("t02-audit-expired", referencePatch("t02"), { premises: [sessionThrows] });
		const t01 = await queued("t01-null-expired", referencePatch("t01"));
		expect((await landIntent(env, t02.id, "rebase", deps)).kind).toBe("landed");
		const afterT02 = await store.head("trunk");
		// What t02 left behind: its three acceptance tests and the assertion it made.
		expect(standing.all()).toEqual([{ intentId: t02.id, tests: demoTask("t02-audit-expired").acceptance.map((check) => ({ file: check.testFile, name: check.testName })), assertions: [{ symbol: VERIFY, assertion: SESSION_THROWS }] }]);

		// t01 rebases cleanly, typechecks, and passes its own acceptance tests. Without standing
		// checks it would land here and t02's behaviour on trunk would be broken with nothing red.
		const outcome = await landIntent(env, t01.id, "rebase", deps);
		expect(outcome.kind).toBe("stale");
		expect(await store.head("trunk")).toBe(afterT02);
		if (outcome.kind !== "stale") {
			throw new Error("unreachable");
		}
		expect(outcome.report).toMatchObject({ textConflict: false, typecheck: { ok: true }, ok: false, assertions: { passed: [], failed: [] } });
		expect(outcome.report.tests.passed).toEqual(demoTask("t01-null-expired").acceptance.map((check) => check.testName));
		expect(outcome.report.tests.failed.map((failure) => failure.name)).toEqual([EXPIRED_TEST]);
		expect(outcome.standingFailures).toMatchObject([{ intentId: t02.id, tests: [{ name: EXPIRED_TEST }], relied: [SESSION_THROWS.description] }]);
		expect(outcome.note).toMatch(new RegExp(`^Breaks landed Intent ${t02.id}: its acceptance check "${EXPIRED_TEST}" fails \\(.*session_expired.*\\)\\. It relied on: ${SESSION_THROWS.description}\\.$`));
		expect((await eventsAbout(t01.id)).at(-1)).toMatchObject({ t: "intent.status", status: "stale", note: outcome.note });

		// The way forward: the same change, plus the repair of the code that depended on the old
		// behaviour. That lands, and t02's assertion, which is no longer true, is retired.
		const repaired = await queued("t01-null-expired", { ...referencePatch("t01"), "src/auth/login.ts": referencePatch("t02-rederived")["src/auth/login.ts"] ?? null });
		const landed = await landIntent(env, repaired.id, "rebase", deps);
		expect(landed.kind).toBe("landed");
		expect(standing.all().map((entry) => [entry.intentId, entry.tests.length, entry.assertions.length])).toEqual([[t02.id, 3, 0], [repaired.id, 2, 0]]);
		await t01.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("an Intent may not get round a landed check by editing its test", async () => {
		const { store, deps, queued } = await world();
		const t02 = await queued("t02-audit-expired", referencePatch("t02"), { premises: [sessionThrows] });
		expect((await landIntent(env, t02.id, "rebase", deps)).kind).toBe("landed");
		const head = await store.head("trunk");
		const test = (await store.readFile("trunk", "main", "tests/audit-expired.test.ts")) ?? "";
		const cheat = await queued("t01-null-expired", { ...referencePatch("t01"), "tests/audit-expired.test.ts": test.replace(/assert\.[a-zA-Z]+\(/g, "void (") });
		const outcome = await landIntent(env, cheat.id, "rebase", deps);
		expect(outcome.kind).toBe("stale");
		expect(outcome.kind === "stale" && outcome.note).toContain("cannot be edited");
		expect(await store.head("trunk")).toBe(head);
		await cheat.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("in the demo's own order nothing changes: t01 first, then the re-derived t02, then the control", async () => {
		const { standing, deps, queued, store } = await world();
		const t04 = await queued("t04-session-ttl-header", referencePatch("t04"));
		const t01 = await queued("t01-null-expired", referencePatch("t01"));
		expect((await landIntent(env, t01.id, "rebase", deps)).kind).toBe("landed");
		const again = await startIntent(env, store, "t02-audit-expired");
		await toQueued(again.api, store, again.intent, referencePatch("t02-rederived"));
		expect((await landIntent(env, again.id, "rebase", deps)).kind).toBe("landed");
		expect((await landIntent(env, t04.id, "rebase", deps)).kind).toBe("landed");
		expect(standing.all().map((entry) => entry.tests.length)).toEqual([2, 3, 2]);
	}, 30_000);
});

describe("what the agent sees", () => {
	it("run_checks runs the landed checks too, so the agent learns before the gate does", async () => {
		// A trunk on which t02 has landed. An agent now makes t01's change.
		const store = seededStore(demoWith("t02"));
		const started = await startIntent(env, store, "t01-null-expired");
		const landed = [{ intentId: "ilanded02", tests: demoTask("t02-audit-expired").acceptance.map((check) => ({ file: check.testFile, name: check.testName })), assertions: [{ symbol: VERIFY, assertion: SESSION_THROWS }] }];
		const ctx = createToolContext(env, store, started.api, started.id, async () => landed);
		for (const [path, content] of Object.entries(referencePatch("t01"))) {
			await started.api.writeOverlay(path, content);
		}
		const broken = await runChecks(ctx, await started.api.get());
		expect(broken.ok).toBe(false);
		expect(broken.text).toContain(`FAIL  landed Intent ilanded02  "${EXPIRED_TEST}"`);
		expect(broken.text).toContain(`That Intent relied on: ${SESSION_THROWS.description}. Update the code that depended on it; do not edit its test.`);
		expect(broken.text).toContain("Not all checks pass yet.");
		expect(broken.text.match(/^PASS/gm)).toHaveLength(2); // its own two checks are fine

		// With the dependent code repaired as well, everything passes and nothing is said about landed work.
		await started.api.writeOverlay("src/auth/login.ts", referencePatch("t02-rederived")["src/auth/login.ts"] ?? null);
		const fixed = await runChecks(ctx, await started.api.get());
		expect(fixed).toMatchObject({ ok: true });
		expect(fixed.text).not.toContain("landed Intent");
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("a re-derive is told why its work did not land, and what to do when it broke landed work", () => {
		const intent = { id: "i00000001", goal: "Return null for expired sessions", acceptance: demoTask("t01-null-expired").acceptance, premises: [], why: [], rejectedAlternatives: [] } as unknown as Intent;
		const reason = `Breaks landed Intent ilanded02: its acceptance check "${EXPIRED_TEST}" fails (expected a, got b). It relied on: ${SESSION_THROWS.description}.`;
		const text = briefing({ intent, adoptable: [], mode: "rederive", reason });
		expect(text).toContain(`Why your earlier work did not land:\n- ${reason}`);
		expect(text).toContain("Keep your change, and also update the code that depended on the old behaviour");
		expect(text).toContain("You may not edit or delete that test.");
		// Other reasons are passed on without that advice.
		const plain = briefing({ intent, adoptable: [], mode: "rederive", reason: "Typecheck failed on the new trunk: src/a.ts:3: nope" });
		expect(plain).toContain("- Typecheck failed on the new trunk: src/a.ts:3: nope");
		expect(plain).not.toContain("already landed depends");
		expect(briefing({ intent, adoptable: [], mode: "rederive" })).not.toContain("Why your earlier work did not land");
	});
});

describe("the Landing object keeps the standing checks", () => {
	it("t02 lands, then t01 is stopped, re-derived twice without success, and goes to a person; trunk stays whole", async () => {
		// This lands on the Worker's own trunk, so start from a fresh one.
		for (let waited = 0; waited < 300; waited++) {
			const status = await landing(env).status();
			if (status.queue.length + status.stale.length + status.rederiving.length === 0 && !status.busy) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await resetDemo(env);
		expect(await landing(env).standing()).toEqual([]);
		await using introspector = await introspectWorkflow(env.AGENT_WORKFLOW);
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);

		async function queuedOnTrunk(taskId: string, changes: FileChanges, premises: Premise[] = []) {
			const id = newIntentId();
			const { head } = await store.fork(trunk, id);
			const task = demoTask(taskId);
			const api = intentStub(env, id);
			const intent = await api.init(newIntent({ id, kind: "agent", taskId, goal: task.goal, acceptance: structuredClone(task.acceptance), baseCommit: head }));
			await api.recordPremises(premises);
			await toQueued(api, store, intent, changes);
			return { id, api };
		}
		const waitFor = async (api: IntentApi, wanted: Intent["status"][], timeoutMs: number) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const intent = await api.get();
				if (wanted.includes(intent.status) || Date.now() > deadline) {
					return intent;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		};

		const t02 = await queuedOnTrunk("t02-audit-expired", referencePatch("t02"), [sessionThrows]);
		const t01 = await queuedOnTrunk("t01-null-expired", referencePatch("t01"));
		await landing(env).enqueue(t02.id);
		expect((await waitFor(t02.api, ["landed", "stale", "failed"], 20_000)).status).toBe("landed");
		const afterT02 = await store.head(trunk);
		expect(await landing(env).standing()).toMatchObject([{ intentId: t02.id, assertions: [{ symbol: VERIFY }] }]);

		await landing(env).enqueue(t01.id);
		// There is no recorded re-derive for t01, so both attempts fail and a person is asked.
		const ended = await waitFor(t01.api, ["escalated", "landed", "failed"], 60_000);
		expect(ended.status).toBe("escalated");
		expect(await store.head(trunk)).toBe(afterT02);
		expect(await store.readFile(trunk, "main", "src/auth/session.ts")).toContain("throw new SessionExpiredError");

		const events = await eventsAbout(t01.id);
		const stale = events.find((event) => event.t === "intent.status" && event.status === "stale");
		expect(stale).toMatchObject({ note: expect.stringContaining(`Breaks landed Intent ${t02.id}`) });
		expect(events.filter((event) => event.t === "human.needed")).toMatchObject([{ kind: "fallback", options: ["Retry", "Abandon"] }]);
		// Nobody was told a premise of theirs broke: t02 is landed, and landed work is protected by the gate instead.
		expect((await eventsAbout(t02.id)).some((event) => event.t === "premise.broken")).toBe(false);
		expect((await hub(env).metrics()).behaviouralRegressionsOnTrunk).toBe(0);

		expect((await landing(env).humanChoice(t01.id, "Abandon"))).toBe("failed");
		await Promise.all((await introspector.get()).map((instance) => instance.waitForStatus("complete").catch(() => undefined)));
		// A reset forgets the standing checks along with the trunk they were about.
		await resetDemo(env);
		expect(await landing(env).standing()).toEqual([]);
	}, 120_000);
});
