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
