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

/**
 * For a re-derive. Assertions that still hold are kept. Broken ones are dropped: they are why
 * the Intent is being re-derived, the agent is told about them, and the gate must not go on
 * demanding something that is no longer true. Everything the agent read or used is cleared,
 * because it will read again on the new trunk.
 */
export function premisesForRederive(premises: readonly Premise[]): Premise[] {
	return premises.filter((premise) => premise.source === "asserted" && premise.state === "holding");
}

/**
 * Whether an asserted premise is about `symbol`: it was filed under it, or its code calls it. An
 * assertion is filed under one symbol, the first function it calls in the order its imports are
 * listed, so the filing alone would make the answer depend on that order.
 */
export function isAbout(premise: Premise, symbol: SymbolId): boolean {
	if (premise.symbol === symbol) {
		return true;
	}
	return premise.assertion !== undefined && callsFunction(premise.assertion.code, symbol.split("#")[1] ?? "");
}

/** Code with its comments taken out, so that a name in a comment is not read as a use of it. */
export const withoutComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");

/**
 * The namespaces of imports in `code`: `const ns = { a, b, c };`, which is what `import * as ns from` is
 * turned into when an assertion is tidied (agent/assertion-input.ts). Each maps to the names it holds.
 * An object with anything but bare names in it (`{ a: () => 1 }`) is somebody's own object, not a namespace.
 */
function namespaces(code: string): Map<string, Set<string>> {
	const found = new Map<string, Set<string>>();
	for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*,?\s*\}/g)) {
		found.set(match[1] as string, new Set((match[2] as string).split(",").map((name) => name.trim())));
	}
	return found;
}

/**
 * Whether `code` calls the function `name` itself: by its name, or through a namespace of its import
 * (`session.verifySession(...)`). Not a method of that name on some other object, and not in a comment.
 */
export function callsFunction(code: string, name: string): boolean {
	if (name === "") {
		return false;
	}
	const bare = withoutComments(code);
	const escape = (text: string) => text.replace(/[$]/g, "\\$");
	if (new RegExp(`(^|[^A-Za-z0-9_$.])${escape(name)}\\s*\\(`).test(bare)) {
		return true;
	}
	return [...namespaces(bare)].some(([alias, names]) => names.has(name) && new RegExp(`(^|[^A-Za-z0-9_$.])${escape(alias)}\\s*\\.\\s*${escape(name)}\\s*\\(`).test(bare));
}

/**
 * An Intent cannot rely on how a symbol behaves and also change that symbol: the assertion would
 * be about the code it is replacing, and its own change would break it. So when an Intent declares
 * what it will change, its assertions about those symbols are withdrawn. What it read stays.
 */
export function withdrawOwn(premises: readonly Premise[], changing: Iterable<SymbolId>): { kept: Premise[]; withdrawn: Premise[] } {
	const own = new Set(changing);
	const exercisesOwn = (premise: Premise) => [...own].some((symbol) => isAbout(premise, symbol));
	const kept: Premise[] = [];
	const withdrawn: Premise[] = [];
	for (const premise of premises) {
		(premise.source === "asserted" && exercisesOwn(premise) ? withdrawn : kept).push(premise);
	}
	return { kept, withdrawn };
}
