import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Intent } from "../../shared/types";
import { hub } from "../hub/publish";
import { ledgerShard } from "../ledger/client";
import type { LlmTurn } from "../ports/llm";
import { demoTask, memorySteps, replay, scriptFor, seededStore, startIntent } from "../testing/agent";
import { demoWith } from "../testing/demo";
import { handOff } from "./handoff";
import { briefing, rederiveBlock, SYSTEM_PROMPT } from "./prompts";
import { type AgentDeps, type AgentParams, MAX_CLAIM_ROUNDS, PLAN_TURNS, runAgent, type Steps, WORK_TURNS } from "./run";
import { AGENT_SCRIPTS, scriptKey } from "./scripts";

// These tests use the demo repo's real symbol names, and the ledger is shared by the whole test
// run. So every test that gets a claim granted ends by failing its Intent, which releases it.
type Store = ReturnType<typeof seededStore>;

async function run(store: Store, started: Awaited<ReturnType<typeof startIntent>>, turns: readonly LlmTurn[], options: { mode?: AgentParams["mode"]; steps?: Steps & { names: string[] }; priority?: number } = {}) {
	const steps = options.steps ?? memorySteps();
	const deps: AgentDeps = { env, store, intent: started.api, llm: replay(turns), handOff: (intent, commit) => handOff(env, intent, commit, { store }) };
	const outcome = await runAgent(deps, { intentId: started.id, mode: options.mode ?? "fresh", ...(options.priority === undefined ? {} : { priority: options.priority }) }, steps);
	return { outcome, steps, intent: await started.api.get() };
}

async function eventsFor(id: string): Promise<PremiseEvent[]> {
	return (await hub(env).since(0, 5000)).filter((event) => ("id" in event && event.id === id) || (event.t === "intent.created" && event.intent.id === id) || (event.t === "artifacts" && event.repo === id));
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): LlmTurn => ({ blocks: [{ type: "tool_use", id, name, input }], stop: "tool_use", usage: { input: 10, output: 5 } });
const text = (value: string): LlmTurn => ({ blocks: [{ type: "text", text: value }], stop: "end_turn", usage: { input: 10, output: 5 } });

describe("prompts", () => {
	const intent = { id: "i00000001", goal: "Audit expired sessions", acceptance: demoTask("t02-audit-expired").acceptance, premises: [], why: [], rejectedAlternatives: [] } as unknown as Intent;

	it("the system prompt covers what the task requires agents to be told", () => {
		for (const phrase of ["Reading tells the platform what your work relies on", "assert_premise", "smallest set of exported symbols", 'mode "interface" only if', "at most three short", "run_checks", "submit"]) {
			expect(SYSTEM_PROMPT).toContain(phrase);
		}
	});

	it("the briefing lists the goal, each acceptance check with its file and name, hints and adoptable assertions", () => {
		const message = briefing({ intent, task: demoTask("t02-audit-expired"), adoptable: [{ id: "a-session-throws", description: "verifySession throws on expiry" }], mode: "fresh" });
		expect(message).toContain("Goal: Audit expired sessions");
		expect(message).toContain("- t02-ac1: An expired session gives one session.expired audit entry and the expired response.");
		expect(message).toContain("  test file: tests/audit-expired.test.ts");
		expect(message).toContain('  test name: "an expired session writes an audit entry and returns expired"');
		expect(message).toContain("- a-session-throws: verifySession throws on expiry");
		expect(message).toContain("Hints:");
		expect(message).not.toContain("re-derive");
	});

	it("a re-derive briefing says what broke, the earlier reasoning, and that the checks are unchanged", () => {
		const stale = {
			...intent,
			why: ["Audit in the catch branch."],
			rejectedAlternatives: ["Change verifySession."],
			premises: [{ symbol: "src/auth/session.ts#verifySession", source: "asserted", surfaceHash: null, state: "broken", assertion: { id: "a1", description: "verifySession throws on expiry", code: "", imports: [] }, brokenBy: { intentId: "i9", commit: "c".repeat(40), reason: "it now returns null" } }],
		} as unknown as Intent;
		const block = rederiveBlock(stale);
		expect(block).toContain("- verifySession throws on expiry: it now returns null");
		expect(block).toContain("- Audit in the catch branch.");
		expect(block).toContain("- Change verifySession.");
		expect(block).toContain("Trunk changed underneath you. Re-implement the same goal on the new trunk. The acceptance checks are unchanged.");
		expect(briefing({ intent: stale, adoptable: [], mode: "rederive" })).toContain(block);
	});
});

describe("agent scripts", () => {
	it("exist for every task, plus a re-derive for the three that rely on the throw", () => {
		expect(Object.keys(AGENT_SCRIPTS).sort()).toEqual(
			[...["t01-null-expired", "t02-audit-expired", "t03-expired-metrics", "t04-session-ttl-header", "t05-tax-rounding", "t06-discount-stacking", "t07-role-check", "t08-profile-validation", "t09-currency-format", "t10-invoice-numbering", "t11-expired-rate-limit", "t12-password-policy"], "t02-audit-expired.rederive", "t03-expired-metrics.rederive", "t11-expired-rate-limit.rederive"].sort(),
		);
		expect(scriptKey({ taskId: "t02-audit-expired" }, "rederive")).toBe("t02-audit-expired.rederive");
		expect(scriptKey({ taskId: "t02-audit-expired" }, "fresh", "custom")).toBe("custom");
	});
});

describe("runAgent: a scripted run of t04, end to end", () => {
	it("plans, claims, works, pushes and hands off", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t04-session-ttl-header");
		const { outcome, steps, intent } = await run(store, started, scriptFor("t04-session-ttl-header"));

		expect(outcome).toMatchObject({ result: "submitted", turns: 5 });
		expect(steps.names).toEqual(["load", "plan-turn-1", "plan-turn-2", "claim-1", "work-turn-1", "work-turn-2", "work-turn-3", "push", "record-push", "hand-off"]);

		// The Intent went all the way to the gate's queue.
		expect(intent.status).toBe("queued");
		expect(intent.claims).toEqual([{ symbol: "src/api/responses.ts#withSessionHeaders", mode: "body" }]);
		expect(intent.why).toHaveLength(1);
		// It read session.ts, so it relies on verifySession by type.
		expect(intent.premises.find((premise) => premise.symbol === "src/auth/session.ts#verifySession")).toMatchObject({ source: "observed", state: "holding" });

		// The fork head moved, and the push carries the work and the Intent record.
		const head = await store.head(started.id);
		expect(head).not.toBe(started.intent.baseCommit);
		expect(intent.headCommit).toBe(head);
		expect(outcome.result === "submitted" && outcome.commit).toBe(head);
		expect(await store.changedPaths(started.id, started.intent.baseCommit, head)).toEqual([".intent/intent.json", "src/api/responses.ts", "tests/session-ttl-header.test.ts"]);
		expect(await store.readFile(started.id, "main", "src/api/responses.ts")).toContain('"x-session-ttl"');
		expect(JSON.parse((await store.readFile(started.id, "main", ".intent/intent.json")) ?? "{}")).toMatchObject({ id: started.id, taskId: "t04-session-ttl-header", acceptance: demoTask("t04-session-ttl-header").acceptance });
		// Trunk is untouched: agents never push there.
		expect(await store.head("trunk")).toBe(started.intent.baseCommit);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("publishes the run as events, in order", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t04-session-ttl-header");
		await run(store, started, scriptFor("t04-session-ttl-header"));
		const events = await eventsFor(started.id);
		const statuses = events.flatMap((event) => (event.t === "intent.status" ? [event.status] : []));
		expect(statuses).toEqual(["claiming", "working", "submitted", "checking", "queued"]);

		const order = events.map((event) => event.t).filter((t, index, all) => t !== all[index - 1]);
		expect(order).toEqual(["intent.created", "premise.recorded", "intent.why", "intent.status", "claim.decision", "intent.status", "artifacts", "intent.status", "push.checked", "premise.recorded", "intent.status"]);
		expect(events.find((event) => event.t === "claim.decision")).toMatchObject({ decision: { kind: "granted" }, symbols: ["src/api/responses.ts#withSessionHeaders"] });
		expect(events.find((event) => event.t === "artifacts")).toMatchObject({ type: "pushed", repo: started.id });
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("holds its claim in the ledger while it waits at the gate", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t04-session-ttl-header");
		await run(store, started, scriptFor("t04-session-ttl-header"));
		const claims = (await ledgerShard(env, "src/api").snapshot()).claims.filter((claim) => claim.intentId === started.id);
		expect(claims.map((claim) => claim.symbol)).toEqual(["src/api/responses.ts#withSessionHeaders"]);
		// Failing (or landing) the Intent is what releases it.
		await started.api.act({ a: "fail" }, "test cleanup");
		expect((await ledgerShard(env, "src/api").snapshot()).claims.filter((claim) => claim.intentId === started.id)).toEqual([]);
	}, 30_000);
});

describe("runAgent: every recorded script completes", () => {
	const fresh = Object.keys(AGENT_SCRIPTS).filter((key) => !key.endsWith(".rederive")).sort();
	for (const taskId of fresh) {
		it(taskId, async () => {
			const store = seededStore();
			const started = await startIntent(env, store, taskId);
			const { outcome, intent } = await run(store, started, scriptFor(taskId));
			expect(outcome).toMatchObject({ result: "submitted" });
			expect(intent.status).toBe("queued");
			// Free the ledger so the next task (some share symbols) starts clean.
			await started.api.act({ a: "fail" }, "test cleanup");
		}, 30_000);
	}

	it("the three that rely on the throw record the assertion", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		const { intent } = await run(store, started, scriptFor("t02-audit-expired"));
		expect(intent.premises.filter((premise) => premise.source === "asserted").map((premise) => [premise.symbol, premise.assertion?.id])).toEqual([["src/auth/session.ts#verifySession", "a-session-throws"]]);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);
});

describe("runAgent: re-derive", () => {
	it("re-runs the Intent on a fresh fork of the new trunk, without changing its status", async () => {
		// Trunk after t01 landed: verifySession returns null on expiry.
		const store = seededStore(demoWith("t01"));
		const started = await startIntent(env, store, "t02-audit-expired");
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "stale" }, { a: "rederive" }] as const) {
			await started.api.act(action);
		}
		await started.api.setWhy(["Audit in the catch branch."]);
		const fork = `${started.id}-r1`;
		const { head } = await store.fork("trunk", fork);
		await started.api.restartOn(fork, head);

		const { outcome, intent, steps } = await run(store, started, scriptFor("t02-audit-expired", "rederive"), { mode: "rederive" });
		expect(outcome).toMatchObject({ result: "submitted" });
		expect(intent.status).toBe("rederiving"); // the gate decides what happens next
		expect(intent.repo).toBe(fork);
		expect(intent.headCommit).toBe(await store.head(fork));
		expect(await store.readFile(fork, "main", "src/auth/login.ts")).toContain("isExpired(stored, deps.now)");
		// It asserted what is true now, not what used to be.
		expect(intent.premises.filter((premise) => premise.source === "asserted").map((premise) => premise.assertion?.description)).toEqual(["verifySession returns null for an expired session"]);
		expect(steps.names).toContain("claim-1");
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("the fresh script does not work on the new trunk: that is why a re-derive is needed", async () => {
		const store = seededStore(demoWith("t01"));
		const started = await startIntent(env, store, "t02-audit-expired");
		const { outcome } = await run(store, started, scriptFor("t02-audit-expired"));
		// The old plan's premise no longer holds, so its assertion is refused and its checks cannot pass.
		expect(outcome.result).toBe("failed");
	}, 30_000);
});

describe("runAgent: the ledger's answers", () => {
	it("Split: the second Intent keeps only what the ledger left it", async () => {
		const store = seededStore();
		const tax = await startIntent(env, store, "t05-tax-rounding");
		const discount = await startIntent(env, store, "t06-discount-stacking");
		await run(store, tax, scriptFor("t05-tax-rounding"));
		const { outcome, intent, steps } = await run(store, discount, scriptFor("t06-discount-stacking"));

		expect(outcome).toMatchObject({ result: "submitted" });
		expect(steps.names).toContain("accept-split-1");
		expect(intent.claims).toEqual([{ symbol: "src/billing/discount.ts#applyDiscounts", mode: "interface" }]);
		const decision = (await eventsFor(discount.id)).find((event) => event.t === "claim.decision");
		expect(decision).toMatchObject({ decision: { kind: "split", with: tax.id, proposal: { mine: ["src/billing/discount.ts#applyDiscounts"] } } });
		await tax.api.act({ a: "fail" }, "test cleanup");
		await discount.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("Wait: the second Intent waits, is woken, and is granted once the first is out of the way", async () => {
		const store = seededStore();
		const first = await startIntent(env, store, "t09-currency-format");
		const second = await startIntent(env, store, "t09-currency-format");
		await run(store, first, scriptFor("t09-currency-format"));

		const waits: string[] = [];
		const steps = memorySteps(async (name, type) => {
			waits.push(`${name}:${type}`);
			expect((await second.api.get()).status).toBe("waiting");
			await first.api.act({ a: "fail" }, "abandoned"); // releases its claims
			return {};
		});
		const { outcome, intent } = await run(store, second, scriptFor("t09-currency-format"), { steps });

		expect(waits).toEqual(["wait-ledger-1:ledger-free"]);
		expect(outcome).toMatchObject({ result: "submitted" });
		expect(intent.status).toBe("queued");
		const statuses = (await eventsFor(second.id)).flatMap((event) => (event.t === "intent.status" ? [event.status] : []));
		expect(statuses).toEqual(["claiming", "waiting", "claiming", "working", "submitted", "checking", "queued"]);
		await second.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);

	it("gives up when the ledger never grants", async () => {
		const store = seededStore();
		const first = await startIntent(env, store, "t08-profile-validation");
		const second = await startIntent(env, store, "t08-profile-validation");
		await run(store, first, scriptFor("t08-profile-validation"));
		const { outcome, intent } = await run(store, second, scriptFor("t08-profile-validation"));
		expect(outcome).toMatchObject({ result: "failed", reason: `the ledger did not grant the claims after ${MAX_CLAIM_ROUNDS} rounds` });
		expect(intent.status).toBe("failed");
		await first.api.act({ a: "fail" }, "test cleanup");
	}, 60_000);
});

describe("runAgent: when things go wrong", () => {
	const declare = toolUse("d1", "declare_changes", { claims: [{ symbol: "src/users/roles.ts#hasRole", mode: "body" }], why: ["test"] });

	it("fails the Intent when the plan turns run out", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t07-role-check");
		const turns = Array.from({ length: PLAN_TURNS + 1 }, (_, index) => toolUse(`l${index}`, "list_files", { dir: "src/users" }));
		const { outcome, intent, steps } = await run(store, started, turns);
		expect(outcome).toMatchObject({ result: "failed", reason: `the agent used all ${PLAN_TURNS} plan turns without declaring its changes`, turns: PLAN_TURNS });
		expect(intent.status).toBe("failed");
		expect(steps.names.filter((name) => name.startsWith("plan-turn-"))).toHaveLength(PLAN_TURNS);
	}, 30_000);

	it("fails the Intent when the work turns run out", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t07-role-check");
		const turns = [declare, ...Array.from({ length: WORK_TURNS + 1 }, (_, index) => toolUse(`c${index}`, "run_checks", {}))];
		const { outcome, intent } = await run(store, started, turns);
		expect(outcome).toMatchObject({ result: "failed", reason: `the agent used all ${WORK_TURNS} work turns without submitting` });
		expect(intent.status).toBe("failed");
		// A failed Intent holds nothing in the ledger.
		expect((await ledgerShard(env, "src/users").snapshot()).claims.filter((claim) => claim.intentId === started.id)).toEqual([]);
	}, 60_000);

	it("nudges a turn with no tool call, and answers unreadable or out-of-phase calls with errors", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t07-role-check");
		const script = scriptFor("t07-role-check");
		const badInput: LlmTurn = { blocks: [{ type: "tool_use", id: "bad1", name: "read_file", input: {}, inputError: "the tool arguments were not valid JSON" }], stop: "tool_use", usage: { input: 1, output: 1 } };
		const early = toolUse("w0", "write_file", { path: "src/users/roles.ts", content: "too early" });
		const seen: string[] = [];
		const deps: AgentDeps = {
			env,
			store,
			intent: started.api,
			handOff: (intent, commit) => handOff(env, intent, commit, { store }),
			llm: (intent, messages) => {
				const last = messages.at(-1);
				seen.push(last === undefined || last.role !== "user" ? "" : typeof last.content === "string" ? last.content : last.content.map((block) => `${block.is_error ? "ERR " : ""}${block.content}`).join(" | "));
				return replay([text("Let me think."), badInput, early, ...script])(intent, messages);
			},
		};
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, memorySteps());
		expect(outcome).toMatchObject({ result: "submitted" });
		expect(seen[1]).toBe("Continue by calling a tool.");
		expect(seen[2]).toBe("ERR The input could not be read: the tool arguments were not valid JSON. Send the tool input as a JSON object.");
		expect(seen[3]).toContain("ERR write_file is not allowed in the plan phase");
		// The premature write never reached the fork.
		expect(await store.readFile(started.id, "main", "src/users/roles.ts")).toContain("canAccess");
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("fails the Intent when the model refuses", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t07-role-check");
		const { outcome, intent } = await run(store, started, [{ blocks: [], stop: "refusal", usage: { input: 1, output: 0 } }]);
		expect(outcome).toMatchObject({ result: "failed", reason: "the model declined to continue" });
		expect(intent.status).toBe("failed");
	});

	it("fails the Intent, with the reason, when the model client throws", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t07-role-check");
		const { outcome, intent } = await run(store, started, []);
		expect(outcome.result).toBe("failed");
		expect(outcome.result === "failed" && outcome.reason).toContain("ScriptedLlm has no turns");
		expect(intent.status).toBe("failed");
	});

	it("stops quietly when a premise breaks mid-work and the Intent goes stale", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t02-audit-expired");
		const script = scriptFor("t02-audit-expired");
		let turnsSeen = 0;
		const deps: AgentDeps = {
			env,
			store,
			intent: started.api,
			handOff: (intent, commit) => handOff(env, intent, commit, { store }),
			llm: (intent, messages) => {
				turnsSeen++;
				return replay(script)(intent, messages);
			},
		};
		// After the claim is granted, trunk changes underneath the agent.
		const steps = memorySteps();
		const realDo = steps.do.bind(steps);
		steps.do = async (name, fn) => {
			const result = await realDo(name, fn);
			if (name === "work-turn-1") {
				await started.api.breakPremise("src/auth/session.ts#verifySession", { intentId: "i01nullxp", commit: "e".repeat(40), reason: "verifySession no longer throws" }, { assertionId: "a-session-throws" });
			}
			return result;
		};
		const outcome = await runAgent(deps, { intentId: started.id, mode: "fresh" }, steps);
		expect(outcome).toMatchObject({ result: "stopped", reason: "the Intent is stale" });
		expect((await started.api.get()).status).toBe("stale");
		// Nothing was pushed: the stale work stays out of the fork.
		expect(await store.head(started.id)).toBe(started.intent.baseCommit);
		expect(turnsSeen).toBe(4);
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);

	it("does not push twice if the push step is retried", async () => {
		const store = seededStore();
		const started = await startIntent(env, store, "t12-password-policy");
		const steps = memorySteps();
		const realDo = steps.do.bind(steps);
		let pushes = 0;
		steps.do = async (name, fn) => {
			if (name !== "push") {
				return realDo(name, fn);
			}
			pushes++;
			await fn(); // the first attempt commits, then its result is "lost"
			return realDo(name, fn);
		};
		const { outcome } = await run(store, started, scriptFor("t12-password-policy"), { steps });
		expect(pushes).toBe(1);
		expect(outcome).toMatchObject({ result: "submitted", commit: await store.head(started.id) });
		// Exactly one commit on top of the base.
		expect(await store.changedPaths(started.id, started.intent.baseCommit, await store.head(started.id))).toContain("src/auth/password.ts");
		await started.api.act({ a: "fail" }, "test cleanup");
	}, 30_000);
});
