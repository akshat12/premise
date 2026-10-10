// Pure helpers for an Intent's premise list.
import type { CommitSha, IntentId, Premise, PremiseSource, SymbolId } from "../../shared/types";

/** Two records are the same premise when they share a symbol and source, and for assertions the same assertion. */
export function samePremise(a: Premise, b: Premise): boolean {
	return a.symbol === b.symbol && a.source === b.source && a.assertion?.id === b.assertion?.id;
}

/**
 * Adds a premise, or replaces the earlier record of the same premise. Observed, derived and
 * asserted premises on one symbol are kept side by side, so recording that a symbol was read
 * never removes or weakens an assertion about it. A premise that is already broken stays
 * broken when it is recorded again with the same hash.
 */
export function upsertPremise(premises: readonly Premise[], incoming: Premise): Premise[] {
	const index = premises.findIndex((existing) => samePremise(existing, incoming));
	if (index === -1) {
		return [...premises, incoming];
	}
	const existing = premises[index] as Premise;
	const keepBroken = existing.state === "broken" && existing.surfaceHash === incoming.surfaceHash;
	const next = [...premises];
	next[index] = keepBroken ? existing : incoming;
	return next;
}

/** Which of an Intent's premises a break applies to. Default: every holding premise on the symbol. */
export type BreakScope = { assertionId: string } | { sources: PremiseSource[] } | undefined;

export interface BrokenBy {
	intentId: IntentId;
	commit: CommitSha;
	reason: string;
}

/** Marks the matching holding premises broken. `changed` says whether anything was marked. */
export function markBroken(premises: readonly Premise[], symbol: SymbolId, by: BrokenBy, scope?: BreakScope): { premises: Premise[]; changed: boolean } {
	let changed = false;
	const next = premises.map((premise) => {
		if (premise.symbol !== symbol || premise.state === "broken") {
			return premise;
		}
		if (scope !== undefined && "assertionId" in scope && premise.assertion?.id !== scope.assertionId) {
			return premise;
		}
		if (scope !== undefined && "sources" in scope && !scope.sources.includes(premise.source)) {
			return premise;
		}
		changed = true;
		return { ...premise, state: "broken" as const, brokenBy: by };
	});
	return { premises: next, changed };
}

/** For a re-derive: assertions are kept and reset to holding; what the agent read or used is cleared, because it will read again. */
export function premisesForRederive(premises: readonly Premise[]): Premise[] {
	return premises
		.filter((premise) => premise.source === "asserted")
		.map(({ brokenBy: _brokenBy, ...premise }) => ({ ...premise, state: "holding" as const }));
}
