// What the screen shows, worked out from ViewState. Pure: components only lay this out.
import type { IntentId, IntentStatus, SymbolId } from "../../shared/types";
import type { IntentView, ViewState } from "./reduce";

/** What `premise.broken` names as the cause when trunk was pushed to from outside the gate. Not an Intent id. */
export const OUTSIDE = "outside-the-gate";

/** The name part of a symbol id: "src/auth/session.ts#verifySession" -> "verifySession". */
export const symbolName = (symbol: SymbolId) => symbol.slice(symbol.lastIndexOf("#") + 1);
/** The file part: "src/auth/session.ts#verifySession" -> "session.ts". */
export const symbolFile = (symbol: SymbolId) => (symbol.split("#")[0] ?? "").split("/").at(-1) ?? "";
export const shortSha = (commit: string | null) => (commit ? commit.slice(0, 7) : "none");

/**
 * Which layout a window of this width gets.
 * - "wide" (1280 and up): the tape with a full label column.
 * - "medium" (768 to 1279): a narrower label column; the gate readout is two by two.
 * - "phone" (under 768): one Intent to a row, its marks under its name, nothing scrolling sideways.
 */
export type Layout = "wide" | "medium" | "phone";
export const WIDE_FROM = 1280;
export const MEDIUM_FROM = 768;
export const layoutFor = (width: number): Layout => (width >= WIDE_FROM ? "wide" : width >= MEDIUM_FROM ? "medium" : "phone");

/** An Intent's callsign on the live board: the task number and one word. "t02-audit-expired" -> "T02 AUDIT". */
export function callsign(intent: Pick<IntentView, "taskId" | "id">): string {
	const match = /^(t\d+)-([a-z0-9]+)/i.exec(intent.taskId);
	return match ? `${match[1]} ${match[2]}`.toUpperCase() : intent.id.toUpperCase();
}

export type Band = "ink-soft" | "amber" | "redpen" | "bluestamp" | "holds";
export type StatusIcon = "plan" | "wait" | "work" | "check" | "warn" | "gate" | "landed" | "stale" | "rederive" | "bell" | "failed";

/** How each status reads on a row: a band colour, an icon and a word. State is never colour alone. */
export const STATUS_LOOK: Record<IntentStatus, { band: Band; icon: StatusIcon; word: string; /** What the word means, for the tooltip. */ means: string }> = {
	planning: { band: "ink-soft", icon: "plan", word: "planning", means: "Reading the code and deciding what it will change" },
	claiming: { band: "ink-soft", icon: "plan", word: "claiming", means: "Asking the ledger for the symbols it will change" },
	waiting: { band: "amber", icon: "wait", word: "waiting", means: "Another Intent is changing the same symbol; this one waits for it" },
	working: { band: "ink-soft", icon: "work", word: "working", means: "Its agent is writing the change on its own fork" },
	submitted: { band: "ink-soft", icon: "check", word: "pushed", means: "Pushed to its fork; not yet checked" },
	checking: { band: "ink-soft", icon: "check", word: "checking", means: "Comparing what it changed with what it said it would change" },
	quarantined: { band: "amber", icon: "warn", word: "quarantined", means: "It changed a symbol it had not claimed, so it is held back" },
	queued: { band: "ink-soft", icon: "gate", word: "at the gate", means: "Waiting its turn at the gate" },
	gating: { band: "ink-soft", icon: "gate", word: "in the gate", means: "The gate is running: rebase, typecheck, tests, premise assertions" },
	landed: { band: "holds", icon: "landed", word: "landed", means: "Passed the gate and is on trunk" },
	stale: { band: "redpen", icon: "stale", word: "stopped", means: "Something it relies on changed on trunk. Its work is stopped until it is redone" },
	rederiving: { band: "bluestamp", icon: "rederive", word: "re-deriving", means: "Redoing the work on the new trunk: a plain rebase first, then the agent if that does not pass" },
	escalated: { band: "redpen", icon: "bell", word: "needs you", means: "It could not be settled automatically, so a person is asked" },
	failed: { band: "redpen", icon: "failed", word: "did not land", means: "It gave up without landing" },
};

/** The other Intent this one is waiting on, if the ledger said to wait or depend. */
export function waitingOn(intent: Pick<IntentView, "status" | "decision">): IntentId | undefined {
	if (intent.status !== "waiting" && intent.status !== "quarantined") {
		return undefined;
	}
	const decision = intent.decision;
	return decision?.kind === "wait" || decision?.kind === "depend" ? decision.on : decision?.kind === "split" ? decision.with : undefined;
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

/** The drawer is never dragged shorter than this (its header and a couple of lines stay readable). */
export const DRAWER_MIN_HEIGHT = 140;
/** What stays visible above the drawer however far up it is dragged: the top bar and one row. */
export const DRAWER_TOP_ROOM = 150;
/** One press of an arrow key on the drawer's handle. */
export const DRAWER_STEP = 32;

/** The height a dragged drawer may have in a window `viewport` pixels high. Pure. */
export function clampDrawerHeight(wanted: number, viewport: number): number {
	const most = Math.max(DRAWER_MIN_HEIGHT, viewport - DRAWER_TOP_ROOM);
	return Math.round(Math.min(most, Math.max(DRAWER_MIN_HEIGHT, wanted)));
}
