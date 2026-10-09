// Writes src/ui/fixtures/sample-run.json: a hand-authored event log that tells the demo story.
// The UI tasks (T20-T23) build against it. Re-run with `node scripts/make-sample-run.mjs` after editing.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const sha = (label) => createHash("sha1").update(label).digest("hex");
const VERIFY = "src/auth/session.ts#verifySession";
const TOTAL = "src/billing/invoice.ts#computeTotal";

// id, task, goal, the symbols it changes
const INTENTS = [
	["i01nullxp", "t01-null-expired", "Make verifySession return null for expired sessions instead of throwing", [VERIFY]],
	["i02auditx", "t02-audit-expired", "Write an audit log entry when a login arrives with an expired session", ["src/auth/login.ts#handleLogin"]],
	["i03metric", "t03-expired-metrics", "Increment metrics.sessionsExpired when a request hits an expired session", ["src/api/handlers.ts#authenticate"]],
	["i04ttlhdr", "t04-session-ttl-header", "Add an X-Session-TTL header to authenticated responses", ["src/api/responses.ts#withSessionHeaders"]],
	["i05taxrnd", "t05-tax-rounding", "Round tax half-to-even per line item", ["src/billing/tax.ts#taxFor", TOTAL]],
	["i06discnt", "t06-discount-stacking", "Apply at most one percentage discount and one fixed discount per invoice", ["src/billing/discount.ts#applyDiscounts"]],
	["i07rolechk", "t07-role-check", "Add a canAccess helper that checks a role against a resource", ["src/users/roles.ts#canAccess"]],
	["i08profil", "t08-profile-validation", "Reject display names longer than 64 characters", ["src/users/profile.ts#validateProfile"]],
	["i09curfmt", "t09-currency-format", "Format zero-decimal currencies without a fraction", ["src/billing/currency.ts#formatMoney"]],
	["i10invnum", "t10-invoice-numbering", "Number invoices per calendar year", ["src/billing/invoice.ts#nextInvoiceNumber"]],
	["i11ratelm", "t11-expired-rate-limit", "Count requests with an expired session against the login rate limit", ["src/auth/rate-limit.ts#guardRequest"]],
	["i12passwd", "t12-password-policy", "Require at least 12 characters and one digit in new passwords", ["src/auth/password.ts#checkPasswordPolicy"]],
].map(([id, taskId, goal, changes]) => ({ id: id.slice(0, 9), taskId, goal, changes }));

const byTask = Object.fromEntries(INTENTS.map((intent) => [intent.taskId.slice(0, 3), intent]));
const C0 = sha("trunk-0");
const SESSION_THROWS = {
	id: "a-session-throws",
	description: "verifySession throws SessionExpiredError on expired tokens",
	code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.throws(() => verifySession('s1', store, () => 10), SessionExpiredError);",
	imports: ["src/auth/session.ts", "src/store/memory-store.ts"],
};

const events = [];
let ts = Date.UTC(2026, 9, 12, 17, 0, 0);
const emit = (body, gapMs = 400) => {
	ts += gapMs;
	events.push({ ...body, seq: events.length + 1, ts });
};

const metrics = {
	agentsActive: 0,
	intentsLanded: 0,
	brokenBuildsOnTrunk: 0,
	behaviouralRegressionsOnTrunk: 0,
	humanMerges: 0,
	premisesBroken: 0,
	rederives: { started: 0, succeeded: 0, failed: 0 },
	forksCreated: 0,
	pushes: 0,
};
const emitMetrics = (change) => {
	Object.assign(metrics, change);
	emit({ t: "metrics", metrics: structuredClone(metrics) }, 100);
};
const status = (task, value, note, gap) => emit({ t: "intent.status", id: byTask[task].id, status: value, ...(note ? { note } : {}) }, gap);
const observed = (task, symbol) =>
	emit({ t: "premise.recorded", id: byTask[task].id, premise: { symbol, source: "observed", surfaceHash: sha(`surface:${symbol}`).slice(0, 16), state: "holding" } }, 250);
const asserted = (task) =>
	emit({ t: "premise.recorded", id: byTask[task].id, premise: { symbol: VERIFY, source: "asserted", surfaceHash: null, assertion: SESSION_THROWS, state: "holding" } }, 250);
const granted = (task) => emit({ t: "claim.decision", id: byTask[task].id, decision: { kind: "granted" }, symbols: byTask[task].changes }, 300);
const gate = (task, path, commit, overrides = {}) =>
	emit({
		t: "gate.result",
		report: {
			intentId: byTask[task].id,
			path,
			textConflict: false,
			typecheck: { ok: true, errors: [] },
			tests: { passed: [`${byTask[task].taskId}-ac1`], failed: [] },
			assertions: { passed: [], failed: [] },
			ok: true,
			landedCommit: commit,
			durationMs: 4200,
			...overrides,
		},
	}, 900);
const land = (task, path, changed) => {
	const commit = sha(`land:${task}`);
	status(task, "gating", undefined, 600);
	gate(task, path, commit);
	emit({ t: "trunk.advanced", commit, byIntent: byTask[task].id, changedSymbols: changed ?? byTask[task].changes }, 200);
	status(task, "landed", undefined, 150);
	metrics.intentsLanded++;
	metrics.agentsActive--;
	metrics.pushes++;
	emitMetrics({});
	return commit;
};

// 1. Twelve Intents are dispatched.
emitMetrics({});
for (const intent of INTENTS) {
	emit({
		t: "intent.created",
		intent: { id: intent.id, kind: "agent", taskId: intent.taskId, goal: intent.goal, status: "planning", claims: [], premises: [], why: [], baseCommit: C0, headCommit: null, rederiveAttempts: 0 },
	}, 150);
}
emit({ t: "artifacts", type: "repo.forked", repo: byTask.t01.id, detail: { source: "trunk", forks: 12 } }, 100);
emitMetrics({ agentsActive: 12, forksCreated: 12 });

// 2. Agents read code (observed premises), assert behaviour, and claim what they will change.
observed("t01", "src/auth/session.ts#SessionExpiredError");
observed("t02", VERIFY);
asserted("t02");
observed("t03", VERIFY);
asserted("t03");
observed("t11", VERIFY);
asserted("t11");
observed("t04", VERIFY);
observed("t05", TOTAL);
observed("t06", TOTAL);

for (const task of ["t01", "t02", "t03", "t04", "t11", "t05"]) {
	granted(task);
}
emit({ t: "intent.why", id: byTask.t01.id, why: ["Callers want one 'no session' path.", "Return type is already Session | null.", "No signature change."] }, 200);
emit({ t: "intent.why", id: byTask.t02.id, why: ["verifySession throws on expiry.", "Record the audit entry in the catch branch."] }, 200);

// A collision: t06 also wants computeTotal, which t05 holds. The ledger proposes a Split.
emit({
	t: "claim.decision",
	id: byTask.t06.id,
	decision: { kind: "split", with: byTask.t05.id, proposal: { mine: ["src/billing/discount.ts#applyDiscounts"], theirs: [TOTAL] } },
	symbols: ["src/billing/discount.ts#applyDiscounts", TOTAL],
}, 500);
granted("t06");
for (const task of ["t07", "t08", "t09", "t12"]) {
	granted(task);
}

// A stalemate: t10 and t05 keep colliding in invoice.ts, so a person decides.
emit({ t: "claim.decision", id: byTask.t10.id, decision: { kind: "wait", on: byTask.t05.id, symbols: [TOTAL] }, symbols: ["src/billing/invoice.ts#nextInvoiceNumber", TOTAL] }, 400);
status("t10", "escalated", "Stalemate with t05-tax-rounding over src/billing/invoice.ts", 300);
emit({ t: "human.needed", id: byTask.t10.id, kind: "stalemate", message: "t10-invoice-numbering and t05-tax-rounding both want computeTotal and neither has landed.", options: ["Wait", "Split", "Depend"] }, 100);

for (const task of ["t01", "t02", "t03", "t11", "t04", "t05", "t06", "t07"]) {
	status(task, "working", undefined, 200);
}
emit({ t: "human.resolved", id: byTask.t10.id, choice: "Wait" }, 1500);
status("t10", "waiting", "Waiting on t05-tax-rounding", 100);

// 3. t01 lands: verifySession keeps its signature but stops throwing.
status("t01", "submitted", undefined, 2500);
const t01Head = sha("push:t01");
emit({ t: "push.checked", id: byTask.t01.id, commit: t01Head, touched: [VERIFY], outOfClaim: [] }, 500);
status("t01", "queued", undefined, 200);
const c1 = land("t01", "rebase", [VERIFY]);

// 4. Three in-flight Intents relied on the throw. Their assertion now fails; t04's type-surface premise holds.
for (const task of ["t02", "t03", "t11"]) {
	emit({ t: "premise.broken", id: byTask[task].id, symbol: VERIFY, byIntent: byTask.t01.id, commit: c1, reason: "verifySession no longer throws SessionExpiredError on expired tokens (assertion a-session-throws failed)" }, 250);
	status(task, "stale", "A premise broke on trunk", 100);
}
emitMetrics({ premisesBroken: 3 });

// 5. Each stale Intent races a textual rebase against a re-derive.
for (const task of ["t02", "t03", "t11"]) {
	status(task, "rederiving", undefined, 300);
	emit({ t: "rederive.race", id: byTask[task].id, rebase: "pending", rederive: "pending" }, 100);
}
emit({ t: "artifacts", type: "repo.forked", repo: `${byTask.t02.id}-r1`, detail: { source: "trunk", forks: 3 } }, 100);
emitMetrics({ rederives: { started: 3, succeeded: 0, failed: 0 }, forksCreated: 15 });
for (const task of ["t02", "t03", "t11"]) {
	emit({ t: "rederive.race", id: byTask[task].id, rebase: "fail", rederive: "pending" }, 1800);
}
emit({ t: "demo.marker", label: "⏩ 2 min compressed" }, 120_000);
for (const task of ["t02", "t03", "t11"]) {
	emit({ t: "rederive.race", id: byTask[task].id, rebase: "fail", rederive: "pass", winner: "rederive" }, 1200);
}
emitMetrics({ rederives: { started: 3, succeeded: 3, failed: 0 } });

// 6. The re-derived work lands, then the rest.
for (const task of ["t02", "t03", "t11"]) {
	land(task, "rederive");
}
status("t04", "submitted", undefined, 800);
emit({ t: "push.checked", id: byTask.t04.id, commit: sha("push:t04"), touched: byTask.t04.changes, outOfClaim: [] }, 400);
status("t04", "queued", undefined, 200);
land("t04", "rebase");
land("t05", "rebase");
land("t07", "rebase");

for (const [index, event] of events.entries()) {
	if (event.seq !== index + 1) {
		throw new Error("seq out of order");
	}
}
writeFileSync(new URL("../src/ui/fixtures/sample-run.json", import.meta.url), `${JSON.stringify(events, null, "\t")}\n`);
console.log(`wrote ${events.length} events`);
