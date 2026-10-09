# T02: Shared types and event schema

## Goal
Create `src/shared/types.ts` and `src/shared/events.ts` **exactly as specified below**. You may add JSDoc comments, but do not rename anything. Also add small helpers with unit tests. Every later task depends on these names.

## Read first
- `CLAUDE.md`
- `docs/SPEC.md`: the "single primitive" and "premise" sections

## `src/shared/types.ts` (write this exactly)
```ts
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
```

## `src/shared/events.ts` (write this exactly)
```ts
import type { Intent, IntentId, IntentStatus, SymbolId, CommitSha, Premise, LedgerDecision, GateReport, Metrics } from "./types";

export type IntentSummary = Pick<Intent, "id" | "kind" | "taskId" | "goal" | "status" | "claims" | "premises" | "why" | "baseCommit" | "headCommit" | "rederiveAttempts">;

export type PremiseEventBody =
  | { t: "intent.created"; intent: IntentSummary }
  | { t: "intent.status"; id: IntentId; status: IntentStatus; note?: string }
  | { t: "intent.why"; id: IntentId; why: string[] }
  | { t: "premise.recorded"; id: IntentId; premise: Premise }
  | { t: "premise.broken"; id: IntentId; symbol: SymbolId; byIntent: IntentId; commit: CommitSha; reason: string }
  | { t: "claim.decision"; id: IntentId; decision: LedgerDecision; symbols: SymbolId[] }
  | { t: "push.checked"; id: IntentId; commit: CommitSha; touched: SymbolId[]; outOfClaim: SymbolId[] }
  | { t: "gate.result"; report: GateReport }
  | { t: "trunk.advanced"; commit: CommitSha; byIntent: IntentId | null; changedSymbols: SymbolId[] }
  | { t: "rederive.race"; id: IntentId; rebase: "pending" | "pass" | "fail"; rederive: "pending" | "pass" | "fail"; winner?: "rebase" | "rederive" }
  | { t: "human.needed"; id: IntentId; kind: "stalemate" | "fallback"; message: string; options: ("Wait" | "Split" | "Depend" | "Retry" | "Abandon")[] }
  | { t: "human.resolved"; id: IntentId; choice: string }
  | { t: "metrics"; metrics: Metrics }
  | { t: "artifacts"; type: string; repo: string; detail?: Record<string, unknown> }
  | { t: "demo.marker"; label: string };     // e.g. "⏩ 3 min compressed"

export type PremiseEvent = PremiseEventBody & { seq: number; ts: number };
```

## Helpers: `src/shared/ids.ts`, plus tests
- `newIntentId(): IntentId`. Use `crypto.getRandomValues`. Return `"i"` + 8 base36 chars.
- `symbolId(path: string, exportName: string): SymbolId`
- `parseSymbolId(id: SymbolId): { path: string; name: string }`. Throw on malformed input.
- `moduleShard(symbol: SymbolId): string`. Return the first two path segments, so `"src/auth/session.ts#x"` gives `"src/auth"`. For a file directly under `src/`, return `"src"`. This decides which LedgerShard DO owns a symbol.
- `isValidRepoName(name: string): boolean`. Use the regex `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, and require length ≤ 63.

## Acceptance
```
npm run typecheck   # 0 errors
npm test            # ids.test.ts: ≥10 assertions incl. moduleShard edge cases, parseSymbolId round-trip, newIntentId validity (1000 samples all valid repo names)
```

## Out of scope
Nothing else.
