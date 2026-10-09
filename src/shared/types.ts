export type IntentId = string;   // "i" + 8 lowercase base36 chars, e.g. "i3k9x0a2q" (valid Artifacts repo name)
export type SymbolId = string;   // "<repo-relative path>#<exportName>", e.g. "src/auth/session.ts#verifySession"
export type CommitSha = string;  // 40-char lowercase hex
export type TaskId = string;     // id from demo-repo/premise/tasks.json, e.g. "t01-audit-expired"

export type IntentKind = "agent" | "workload";

export type IntentStatus =
  | "planning"     // agent reading code (observed premises recorded)
  | "claiming"     // asked ledger for its "changes" claims
  | "waiting"      // ledger said Wait / Depend; paused
  | "working"      // writing code in its fork
  | "submitted"    // pushed to its fork, awaiting checker
  | "checking"     // post-push checker running
  | "quarantined"  // edited outside its claims; awaiting claim upgrade
  | "queued"       // waiting for the gate
  | "gating"       // gate running (rebase, typecheck, tests, assertions)
  | "landed"       // on trunk
  | "stale"        // a premise broke; needs re-derive
  | "rederiving"   // re-derive race in progress
  | "escalated"    // needs a human (stalemate or 2 failed re-derives)
  | "failed";      // gave up

export type PremiseSource = "observed" | "derived" | "asserted";

export interface Assertion {
  id: string;            // "a1", "a2", ...
  description: string;   // one line, shown in UI, e.g. "verifySession throws SessionExpiredError on expired tokens"
  code: string;          // TS function body; runs in the behavioural runner; throw = fail
  imports: string[];     // repo-relative modules it needs, e.g. ["src/auth/session.ts"]
}

export interface Premise {
  symbol: SymbolId;
  source: PremiseSource;
  surfaceHash: string | null;  // type-surface hash when recorded; null for assertion-only premises
  assertion?: Assertion;       // present iff source === "asserted"
  state: "holding" | "broken";
  brokenBy?: { intentId: IntentId; commit: CommitSha; reason: string };
}

export type ClaimMode = "body" | "interface"; // body = exclusive edit of implementation; interface = will change exported surface
export interface Claim { symbol: SymbolId; mode: ClaimMode; }

export interface AcceptanceCheck {
  id: string;          // e.g. "t01-ac1"
  description: string;
  testFile: string;    // repo-relative, e.g. "tests/audit.test.ts"
  testName: string;    // key in that file's exported `tests` object
}

export interface Intent {
  id: IntentId;
  kind: IntentKind;
  taskId: TaskId;
  goal: string;
  acceptance: AcceptanceCheck[];   // frozen at dispatch; NEVER modified afterwards
  claims: Claim[];
  premises: Premise[];
  rejectedAlternatives: string[];
  why: string[];                   // max 3 short lines, written by the agent
  repo: string;                    // Artifacts fork name (== id)
  baseCommit: CommitSha;           // trunk commit the fork started from
  headCommit: CommitSha | null;    // latest pushed commit in the fork
  status: IntentStatus;
  rederiveAttempts: number;
  dependsOn: IntentId[];
  createdAt: number;
  updatedAt: number;
}

export type LedgerDecision =
  | { kind: "granted" }
  | { kind: "wait"; on: IntentId; symbols: SymbolId[] }
  | { kind: "split"; with: IntentId; proposal: { mine: SymbolId[]; theirs: SymbolId[] } }
  | { kind: "depend"; on: IntentId; symbols: SymbolId[] };

export interface GateReport {
  intentId: IntentId;
  path: "rebase" | "rederive" | "baseline";
  textConflict: boolean;
  typecheck: { ok: boolean; errors: string[] };
  tests: { passed: string[]; failed: { name: string; error: string }[] };
  assertions: { passed: string[]; failed: { id: string; error: string }[] };
  ok: boolean;
  landedCommit: CommitSha | null;
  durationMs: number;
}

export interface Metrics {
  agentsActive: number;
  intentsLanded: number;
  brokenBuildsOnTrunk: number;
  behaviouralRegressionsOnTrunk: number;
  humanMerges: number;
  premisesBroken: number;
  rederives: { started: number; succeeded: number; failed: number };
  forksCreated: number;
  pushes: number;
}

export interface TaskDef {   // shape of demo-repo/premise/tasks.json entries
  id: TaskId;
  title: string;
  goal: string;
  acceptance: AcceptanceCheck[];
  hints?: string[];
}
