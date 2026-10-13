// The Intent state machine. Pure: which status an action leads to, or an error if it is not allowed.
import type { CommitSha, IntentStatus } from "../../shared/types";

export type IntentAction =
	| { a: "claim" }
	| { a: "granted" }
	| { a: "wait" }
	| { a: "resume" }
	| { a: "work" }
	| { a: "submit"; commit: CommitSha }
	| { a: "check" }
	| { a: "quarantine" }
	| { a: "upgrade-granted" }
	| { a: "queue" }
	| { a: "gate" }
	| { a: "land"; commit: CommitSha }
	| { a: "stale" }
	| { a: "rederive" }
	| { a: "escalate" }
	| { a: "fail" }
	| { a: "human"; choice: string };

export class IllegalTransition extends Error {
	constructor(
		readonly from: IntentStatus,
		readonly action: IntentAction["a"],
		detail = "",
	) {
		super(`illegal transition: cannot "${action}" an Intent that is ${from}${detail}`);
		this.name = "IllegalTransition";
	}
}

/** Statuses an Intent never leaves. */
export const TERMINAL: readonly IntentStatus[] = ["landed", "failed"];

/** Statuses in which a broken premise turns the Intent stale. */
export const CAN_GO_STALE: readonly IntentStatus[] = ["working", "submitted", "checking", "queued", "gating", "rederiving"];

/** Statuses that count as "in flight": the Intent is still on its way to trunk. */
export const IN_FLIGHT: readonly IntentStatus[] = ["planning", "claiming", "waiting", "working", "submitted", "checking", "quarantined", "queued", "gating", "stale", "rederiving", "escalated"];

type Edges = Partial<Record<IntentAction["a"], IntentStatus>>;

const EDGES: Record<IntentStatus, Edges> = {
	planning: { claim: "claiming" },
	claiming: { granted: "working", wait: "waiting", escalate: "escalated" },
	waiting: { resume: "claiming" },
	working: { submit: "submitted", stale: "stale" },
	submitted: { check: "checking", stale: "stale" },
	checking: { queue: "queued", quarantine: "quarantined", stale: "stale" },
	quarantined: { "upgrade-granted": "queued" },
	queued: { gate: "gating", stale: "stale" },
	gating: { land: "landed", stale: "stale" },
	// `escalate` from stale: its re-derives kept being voided by further changes to trunk, so a person is asked.
	stale: { rederive: "rederiving", escalate: "escalated" },
	rederiving: { land: "landed", stale: "stale", escalate: "escalated" },
	escalated: {},
	landed: {},
	failed: {},
};

/** What a person's choice on an escalated Intent leads to. */
const HUMAN_CHOICES: Record<string, IntentStatus> = {
	Wait: "claiming",
	Split: "claiming",
	Depend: "claiming",
	Retry: "rederiving",
	Abandon: "failed",
};

/**
 * True when an Intent that is `status` looks as it would just after `action` was applied to it.
 * A caller whose request was applied but whose reply was lost asks again, and is refused because
 * the Intent has already moved; this is how it tells that refusal from a real one. Pure.
 */
export function alreadyApplied(status: IntentStatus, action: IntentAction): boolean {
	if (action.a === "fail") {
		return status === "failed";
	}
	if (action.a === "human") {
		return HUMAN_CHOICES[action.choice] === status;
	}
	return Object.values(EDGES).some((edges) => edges[action.a] === status);
}

export function transition(from: IntentStatus, action: IntentAction): IntentStatus {
	if (action.a === "fail") {
		// Anything that is not already finished can fail.
		if (TERMINAL.includes(from)) {
			throw new IllegalTransition(from, action.a);
		}
		return "failed";
	}
	if (action.a === "human") {
		const next = from === "escalated" ? HUMAN_CHOICES[action.choice] : undefined;
		if (next === undefined) {
			throw new IllegalTransition(from, action.a, from === "escalated" ? ` (unknown choice "${action.choice}")` : "");
		}
		return next;
	}
	const next = EDGES[from][action.a];
	if (next === undefined) {
		throw new IllegalTransition(from, action.a);
	}
	return next;
}

export function canTransition(from: IntentStatus, action: IntentAction): boolean {
	try {
		transition(from, action);
		return true;
	} catch {
		return false;
	}
}
