// The only UI state logic. Components render ViewState; they never interpret events themselves.
import type { IntentSummary, PremiseEvent } from "../../shared/events";
import type { Claim, GateReport, IntentId, LedgerDecision, Metrics, Premise, SymbolId } from "../../shared/types";

type RaceLeg = "pending" | "pass" | "fail";
type HumanOption = "Wait" | "Split" | "Depend" | "Retry" | "Abandon";

export interface IntentView extends IntentSummary {
	/** The note on the latest status change, or the reason a premise broke. */
	lastNote?: string;
	/** The latest ledger answer to this Intent's claims. */
	decision?: LedgerDecision;
	/** Symbols the last push edited outside this Intent's claims. */
	outOfClaim?: SymbolId[];
	/** The latest gate report for this Intent. */
	gate?: GateReport;
	race?: { rebase: RaceLeg; rederive: RaceLeg; winner?: "rebase" | "rederive" };
	/** Present while (and after) the Intent needs a person. `resolved` is set once someone has chosen. */
	human?: { kind: "stalemate" | "fallback"; message: string; options: HumanOption[]; resolved?: string };
}

export interface ViewState {
	intents: Record<IntentId, IntentView>;
	trunk: { commit: string | null; landed: IntentId[] };
	metrics: Metrics;
	/** In-flight Intents only: who changes each symbol and who relies on it. */
	ledger: Record<SymbolId, { writer?: IntentId; readers: IntentId[] }>;
	markers: string[];
}

export function initialViewState(): ViewState {
	return {
		intents: {},
		trunk: { commit: null, landed: [] },
		metrics: {
			agentsActive: 0,
			intentsLanded: 0,
			brokenBuildsOnTrunk: 0,
			behaviouralRegressionsOnTrunk: 0,
			humanMerges: 0,
			premisesBroken: 0,
			rederives: { started: 0, succeeded: 0, failed: 0 },
			forksCreated: 0,
			pushes: 0,
		},
		ledger: {},
		markers: [],
	};
}

type Ledger = ViewState["ledger"];

function withWriter(ledger: Ledger, symbols: readonly SymbolId[], id: IntentId): Ledger {
	const next = { ...ledger };
	for (const symbol of symbols) {
		next[symbol] = { readers: next[symbol]?.readers ?? [], writer: id };
	}
	return next;
}

function withReader(ledger: Ledger, symbols: readonly SymbolId[], id: IntentId): Ledger {
	const next = { ...ledger };
	for (const symbol of symbols) {
		const entry = next[symbol] ?? { readers: [] };
		if (!entry.readers.includes(id)) {
			next[symbol] = { ...entry, readers: [...entry.readers, id] };
		}
	}
	return next;
}

/** Drops an Intent from the ledger once it is no longer in flight. Empty entries are removed. */
function withoutIntent(ledger: Ledger, id: IntentId): Ledger {
	const next: Ledger = {};
	for (const [symbol, entry] of Object.entries(ledger)) {
		const readers = entry.readers.filter((reader) => reader !== id);
		const writer = entry.writer === id ? undefined : entry.writer;
		if (writer !== undefined || readers.length > 0) {
			next[symbol] = writer === undefined ? { readers } : { writer, readers };
		}
	}
	return next;
}

function samePremise(a: Premise, b: Premise): boolean {
	return a.symbol === b.symbol && a.source === b.source && a.assertion?.id === b.assertion?.id;
}

function mergeClaims(claims: Claim[], symbols: readonly SymbolId[]): Claim[] {
	const known = new Set(claims.map((claim) => claim.symbol));
	// A granted symbol we have not seen a mode for is shown as a body claim until a later event says otherwise.
	return [...claims, ...symbols.filter((symbol) => !known.has(symbol)).map((symbol): Claim => ({ symbol, mode: "body" }))];
}

/** Applies `change` to one Intent. Events about an Intent we have never seen are ignored. */
function updateIntent(state: ViewState, id: IntentId, change: (intent: IntentView) => IntentView): ViewState {
	const intent = state.intents[id];
	return intent ? { ...state, intents: { ...state.intents, [id]: change(intent) } } : state;
}

export function reduce(state: ViewState, e: PremiseEvent): ViewState {
	switch (e.t) {
		case "intent.created": {
			const intent = e.intent;
			let ledger = withWriter(state.ledger, intent.claims.map((claim) => claim.symbol), intent.id);
			ledger = withReader(ledger, intent.premises.map((premise) => premise.symbol), intent.id);
			return { ...state, intents: { ...state.intents, [intent.id]: { ...intent } }, ledger };
		}

		case "intent.status": {
			if (!state.intents[e.id]) {
				return state;
			}
			const next = updateIntent(state, e.id, (intent) => ({ ...intent, status: e.status, lastNote: e.note ?? intent.lastNote }));
			if (e.status === "landed") {
				const landed = next.trunk.landed.includes(e.id) ? next.trunk.landed : [...next.trunk.landed, e.id];
				return { ...next, trunk: { ...next.trunk, landed }, ledger: withoutIntent(next.ledger, e.id) };
			}
			return e.status === "failed" ? { ...next, ledger: withoutIntent(next.ledger, e.id) } : next;
		}

		case "intent.why":
			return updateIntent(state, e.id, (intent) => ({ ...intent, why: e.why }));

		case "premise.recorded": {
			if (!state.intents[e.id]) {
				return state;
			}
			const next = updateIntent(state, e.id, (intent) => ({
				...intent,
				premises: [...intent.premises.filter((premise) => !samePremise(premise, e.premise)), e.premise],
			}));
			return { ...next, ledger: withReader(next.ledger, [e.premise.symbol], e.id) };
		}

		case "premise.broken":
			return updateIntent(state, e.id, (intent) => ({
				...intent,
				lastNote: e.reason,
				premises: intent.premises.map((premise) =>
					premise.symbol === e.symbol
						? { ...premise, state: "broken", brokenBy: { intentId: e.byIntent, commit: e.commit, reason: e.reason } }
						: premise,
				),
			}));

		case "claim.decision": {
			if (!state.intents[e.id]) {
				return state;
			}
			if (e.decision.kind !== "granted") {
				return updateIntent(state, e.id, (intent) => ({ ...intent, decision: e.decision }));
			}
			const next = updateIntent(state, e.id, (intent) => ({
				...intent,
				decision: e.decision,
				claims: mergeClaims(intent.claims, e.symbols),
			}));
			return { ...next, ledger: withWriter(next.ledger, e.symbols, e.id) };
		}

		case "push.checked":
			return updateIntent(state, e.id, (intent) => ({ ...intent, headCommit: e.commit, outOfClaim: e.outOfClaim }));

		case "gate.result":
			return updateIntent(state, e.report.intentId, (intent) => ({ ...intent, gate: e.report }));

		case "trunk.advanced": {
			const landed =
				e.byIntent === null || state.trunk.landed.includes(e.byIntent) ? state.trunk.landed : [...state.trunk.landed, e.byIntent];
			return { ...state, trunk: { commit: e.commit, landed } };
		}

		case "rederive.race":
			return updateIntent(state, e.id, (intent) => ({
				...intent,
				race: e.winner === undefined ? { rebase: e.rebase, rederive: e.rederive } : { rebase: e.rebase, rederive: e.rederive, winner: e.winner },
			}));

		case "human.needed":
			return updateIntent(state, e.id, (intent) => ({ ...intent, human: { kind: e.kind, message: e.message, options: e.options } }));

		case "human.resolved":
			return updateIntent(state, e.id, (intent) => (intent.human ? { ...intent, human: { ...intent.human, resolved: e.choice } } : intent));

		case "metrics":
			return { ...state, metrics: e.metrics };

		case "artifacts":
			// Platform activity (forks, pushes). The counters arrive in `metrics`, so there is nothing to keep here.
			return state;

		case "demo.marker":
			return { ...state, markers: [...state.markers, e.label] };

		default:
			// An event type this build does not know: leave the state alone.
			return state;
	}
}

export function reduceAll(events: readonly PremiseEvent[], from: ViewState = initialViewState()): ViewState {
	return events.reduce(reduce, from);
}
