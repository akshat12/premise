// The ledger's decision rules. Pure: given what an Intent asks to change and what others already
// hold, say Granted, Wait, Split or Depend. No model is involved, and the same inputs always give
// the same answer.
import type { Claim, ClaimMode, IntentId, LedgerDecision, SymbolId } from "../../shared/types";

export interface HeldClaim {
	intentId: IntentId;
	symbol: SymbolId;
	mode: ClaimMode;
	since: number;
	priority: number;
}

export interface ClaimRequest {
	intentId: IntentId;
	claims: Claim[];
	/** Lower number means higher priority. */
	priority: number;
	dependsOn: IntentId[];
	/**
	 * How many more symbols this Intent is claiming in other ledger shards. A shard only sees its
	 * own symbols, and Split needs to know whether the requester wants anything besides the
	 * contested ones.
	 */
	elsewhere?: number;
}

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** The other Intent to decide against: highest priority, then the one that has held longest, then by id. */
function strongest(conflicts: HeldClaim[]): HeldClaim | undefined {
	const byIntent = new Map<IntentId, HeldClaim>();
	for (const claim of conflicts) {
		const best = byIntent.get(claim.intentId);
		if (best === undefined || claim.since < best.since) {
			byIntent.set(claim.intentId, claim);
		}
	}
	return [...byIntent.values()].sort((a, b) => a.priority - b.priority || a.since - b.since || (a.intentId < b.intentId ? -1 : 1))[0];
}

/**
 * Rules, in order:
 * 1. Granted: nobody else holds any requested symbol.
 * 2. Depend: every contested symbol is held as "interface" by the other Intent and wanted only
 *    as "body" here, or the requester already declared that it depends on the other Intent.
 * 3. Split: both sides also have at least one symbol that is not contested. The contested
 *    symbols go to the higher-priority side; a tie goes to the current holder.
 * 4. Wait: any other overlap.
 */
export function decide(req: ClaimRequest, held: HeldClaim[]): LedgerDecision {
	const wanted = new Map(req.claims.map((claim) => [claim.symbol, claim.mode]));
	const conflicts = held.filter((claim) => claim.intentId !== req.intentId && wanted.has(claim.symbol));
	const other = strongest(conflicts);
	if (other === undefined) {
		return { kind: "granted" };
	}

	const theirsContested = conflicts.filter((claim) => claim.intentId === other.intentId);
	const contested = sorted(theirsContested.map((claim) => claim.symbol));

	const onlyNeedsBodies = theirsContested.every((claim) => claim.mode === "interface" && wanted.get(claim.symbol) === "body");
	if (onlyNeedsBodies || req.dependsOn.includes(other.intentId)) {
		return { kind: "depend", on: other.intentId, symbols: contested };
	}

	const contestedSet = new Set(contested);
	const mineElsewhere = sorted(req.claims.map((claim) => claim.symbol).filter((symbol) => !contestedSet.has(symbol)));
	const theirsElsewhere = sorted(held.filter((claim) => claim.intentId === other.intentId && !contestedSet.has(claim.symbol)).map((claim) => claim.symbol));
	const requesterHasMore = mineElsewhere.length > 0 || (req.elsewhere ?? 0) > 0;
	if (requesterHasMore && theirsElsewhere.length > 0) {
		// The requester's `since` is "now", which is never earlier than the holder's, so a tie keeps the holder.
		const requesterWins = req.priority < other.priority;
		return {
			kind: "split",
			with: other.intentId,
			proposal: requesterWins
				? { mine: sorted([...mineElsewhere, ...contested]), theirs: theirsElsewhere }
				: { mine: mineElsewhere, theirs: sorted([...theirsElsewhere, ...contested]) },
		};
	}

	return { kind: "wait", on: other.intentId, symbols: contested };
}

export type LedgerHistoryEntry =
	| { type: "decision"; intentId: IntentId; other: IntentId; kind: Exclude<LedgerDecision["kind"], "granted"> }
	| { type: "landed"; intentId: IntentId };

/**
 * True when the same two Intents have been told to Split twice and neither has landed since.
 * At that point more rounds will not help, and a person should choose.
 */
export function isStalemate(a: IntentId, b: IntentId, history: readonly LedgerHistoryEntry[]): boolean {
	let splits = 0;
	for (const entry of history) {
		if (entry.type === "landed") {
			if (entry.intentId === a || entry.intentId === b) {
				splits = 0;
			}
		} else if (entry.kind === "split" && ((entry.intentId === a && entry.other === b) || (entry.intentId === b && entry.other === a))) {
			splits++;
		}
	}
	return splits >= 2;
}
