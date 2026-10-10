// What the screen shows, worked out from ViewState. Pure: components only lay this out.
import type { Claim, IntentId, IntentStatus, Premise, SymbolId } from "../../shared/types";
import type { IntentView, ViewState } from "./reduce";

/** What `premise.broken` names as the cause when trunk was pushed to from outside the gate. Not an Intent id. */
export const OUTSIDE = "outside-the-gate";

/** The name part of a symbol id: "src/auth/session.ts#verifySession" -> "verifySession". */
export const symbolName = (symbol: SymbolId) => symbol.slice(symbol.lastIndexOf("#") + 1);
/** The file part: "src/auth/session.ts#verifySession" -> "session.ts". */
export const symbolFile = (symbol: SymbolId) => (symbol.split("#")[0] ?? "").split("/").at(-1) ?? "";
export const shortSha = (commit: string | null) => (commit ? commit.slice(0, 7) : "none");

/** A strip's callsign: the task number and one word. "t02-audit-expired" -> "T02 AUDIT". */
export function callsign(intent: Pick<IntentView, "taskId" | "id">): string {
	const match = /^(t\d+)-([a-z0-9]+)/i.exec(intent.taskId);
	return match ? `${match[1]} ${match[2]}`.toUpperCase() : intent.id.toUpperCase();
}

export type Band = "ink-soft" | "amber" | "redpen" | "bluestamp" | "holds";
export type StatusIcon = "plan" | "wait" | "work" | "check" | "warn" | "gate" | "landed" | "stale" | "rederive" | "bell" | "failed";

/** How each status reads on a strip: a band colour, an icon and a word. State is never colour alone. */
export const STATUS_LOOK: Record<IntentStatus, { band: Band; icon: StatusIcon; word: string }> = {
	planning: { band: "ink-soft", icon: "plan", word: "planning" },
	claiming: { band: "ink-soft", icon: "plan", word: "claiming" },
	waiting: { band: "amber", icon: "wait", word: "waiting" },
	working: { band: "ink-soft", icon: "work", word: "working" },
	submitted: { band: "ink-soft", icon: "check", word: "pushed" },
	checking: { band: "ink-soft", icon: "check", word: "checking" },
	quarantined: { band: "amber", icon: "warn", word: "quarantined" },
	queued: { band: "ink-soft", icon: "gate", word: "at the gate" },
	gating: { band: "ink-soft", icon: "gate", word: "in the gate" },
	landed: { band: "holds", icon: "landed", word: "landed" },
	stale: { band: "redpen", icon: "stale", word: "stale" },
	rederiving: { band: "bluestamp", icon: "rederive", word: "re-deriving" },
	escalated: { band: "redpen", icon: "bell", word: "needs you" },
	failed: { band: "redpen", icon: "failed", word: "failed" },
};

const REACHED_CHECK: readonly IntentStatus[] = ["submitted", "checking", "quarantined", "queued", "gating", "landed"];
const REACHED_GATE: readonly IntentStatus[] = ["queued", "gating", "landed"];

export interface Bays {
	check: boolean;
	gate: boolean;
	trunk: boolean;
}

/** Which bays the Intent has reached. A bay it has not reached is drawn disabled. */
export function baysReached(intent: Pick<IntentView, "status" | "gate">): Bays {
	return {
		check: REACHED_CHECK.includes(intent.status) || intent.gate !== undefined,
		gate: REACHED_GATE.includes(intent.status) || intent.gate !== undefined,
		trunk: intent.status === "landed",
	};
}

/** The other Intent this one is waiting on, if the ledger said to wait or depend. */
export function waitingOn(intent: Pick<IntentView, "status" | "decision">): IntentId | undefined {
	if (intent.status !== "waiting" && intent.status !== "quarantined") {
		return undefined;
	}
	const decision = intent.decision;
	return decision?.kind === "wait" || decision?.kind === "depend" ? decision.on : decision?.kind === "split" ? decision.with : undefined;
}

export const brokenPremises = (intent: Pick<IntentView, "premises">): Premise[] => intent.premises.filter((premise) => premise.state === "broken");

/**
 * The red-pen note on a strip: short enough to read at a glance. The full reason is in the
 * tooltip and the drawer.
 */
export function annotation(intent: Pick<IntentView, "status" | "premises" | "decision">, callsignOf: (id: IntentId) => string): string | undefined {
	const broken = brokenPremises(intent)[0];
	if (broken !== undefined && (intent.status === "stale" || intent.status === "rederiving" || intent.status === "escalated")) {
		const name = symbolName(broken.symbol);
		return intent.status === "rederiving" ? `${name} changed: re-deriving` : intent.status === "escalated" ? `${name} changed: needs you` : `${name} changed`;
	}
	const other = waitingOn(intent);
	return other === undefined ? undefined : `waiting on ${callsignOf(other).split(" ")[0]}`;
}

export interface Chip {
	symbol: SymbolId;
	kind: "changes" | "relies";
	/** For "changes": body or interface. For "relies": how the Intent came to rely on it. */
	detail: Claim["mode"] | Premise["source"];
	broken: boolean;
	reason?: string;
	hash?: string | null;
	description?: string;
}

// Asserted first (what it said it depends on), then anything else that broke, then what it calls, then what it read.
const SOURCE_RANK: Record<Premise["source"], number> = { asserted: 0, derived: 2, observed: 3 };
const rankOf = (premise: Premise) => (premise.source === "asserted" ? 0 : premise.state === "broken" ? 1 : SOURCE_RANK[premise.source]);

/**
 * The chips on a strip. Every symbol it changes, then what it relies on: broken ones first, then
 * what it asserted, then what its code calls, then what it only read. One chip per symbol.
 */
export function chipsFor(intent: Pick<IntentView, "claims" | "premises"> & { status?: IntentStatus }): Chip[] {
	const changes: Chip[] = intent.claims.map((claim) => ({ symbol: claim.symbol, kind: "changes", detail: claim.mode, broken: false }));
	const claimed = new Set(intent.claims.map((claim) => claim.symbol));
	const bySymbol = new Map<SymbolId, Chip>();
	// Once it has landed, a premise that broke on the way is history: the work on trunk no longer relies on it.
	const current = intent.status === "landed" ? intent.premises.filter((premise) => premise.state !== "broken") : intent.premises;
	const ordered = [...current].sort((a, b) => rankOf(a) - rankOf(b) || Number(b.state === "broken") - Number(a.state === "broken"));
	for (const premise of ordered) {
		if (claimed.has(premise.symbol) || bySymbol.has(premise.symbol)) {
			continue;
		}
		bySymbol.set(premise.symbol, {
			symbol: premise.symbol,
			kind: "relies",
			detail: premise.source,
			broken: premise.state === "broken",
			...(premise.brokenBy ? { reason: premise.brokenBy.reason } : {}),
			hash: premise.surfaceHash,
			...(premise.assertion ? { description: premise.assertion.description } : {}),
		});
	}
	return [...changes, ...bySymbol.values()];
}

/** Whether an Intent changes or relies on a symbol. Used to highlight every strip that touches it. */
export function touches(intent: Pick<IntentView, "claims" | "premises">, symbol: SymbolId): boolean {
	return intent.claims.some((claim) => claim.symbol === symbol) || intent.premises.some((premise) => premise.symbol === symbol);
}

export interface Lanes {
	/** Agents' Intents, in the order they were created. Each gets a strip. */
	agents: IntentView[];
	/** The scripted workload, summarised as one strip. null when there is none. */
	workload: { total: number; landed: number; failed: number; moving: number; stale: number } | null;
}

export function lanesOf(state: ViewState): Lanes {
	const all = Object.values(state.intents);
	const workload = all.filter((intent) => intent.kind === "workload");
	const count = (test: (status: IntentStatus) => boolean) => workload.filter((intent) => test(intent.status)).length;
	return {
		// In task order, so a strip keeps its place however the Intents happened to be created.
		agents: all.filter((intent) => intent.kind !== "workload").sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)),
		workload:
			workload.length === 0
				? null
				: {
						total: workload.length,
						landed: count((status) => status === "landed"),
						failed: count((status) => status === "failed"),
						stale: count((status) => status === "stale" || status === "rederiving"),
						moving: count((status) => !["landed", "failed", "stale", "rederiving"].includes(status)),
					},
	};
}

export interface LedgerRow {
	symbol: SymbolId;
	writer?: IntentId;
	readers: IntentId[];
	/** Someone is changing it while someone else relies on it. */
	contested: boolean;
	/** Readers whose premise on this symbol has broken. */
	broken: IntentId[];
}

/**
 * The ledger rail's rows, agents' Intents only (hundreds of workload Intents would bury them).
 * Symbols with a broken premise come first, then contested ones, then the rest by name.
 */
export function ledgerRows(state: ViewState, limit = 40): LedgerRow[] {
	const isAgent = (id: IntentId) => state.intents[id] !== undefined && state.intents[id]?.kind !== "workload";
	const rows: LedgerRow[] = [];
	for (const [symbol, entry] of Object.entries(state.ledger)) {
		const writer = entry.writer !== undefined && isAgent(entry.writer) ? entry.writer : undefined;
		const readers = entry.readers.filter((id) => isAgent(id) && id !== writer);
		if (writer === undefined && readers.length === 0) {
			continue;
		}
		const broken = readers.filter((id) => state.intents[id]?.premises.some((premise) => premise.symbol === symbol && premise.state === "broken"));
		rows.push({ symbol, ...(writer === undefined ? {} : { writer }), readers, contested: writer !== undefined && readers.length > 0, broken });
	}
	const rank = (row: LedgerRow) => (row.broken.length > 0 ? 0 : row.contested ? 1 : row.writer !== undefined ? 2 : 3);
	return rows.sort((a, b) => rank(a) - rank(b) || b.readers.length - a.readers.length || (symbolName(a.symbol) < symbolName(b.symbol) ? -1 : 1)).slice(0, limit);
}
