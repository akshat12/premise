// The only way the rest of the backend talks to the ledger. A claim request can span several
// shards (one per module directory); this file hides that.
import { moduleShard } from "../../shared/ids";
import type { IntentId, LedgerDecision, SymbolId } from "../../shared/types";
import type { ClaimRequest } from "./decide";
import type { LedgerSnapshot, Reader } from "./ledger-shard";

type LedgerEnv = Pick<Env, "LEDGER">;

/** The LedgerShard RPC surface, declared by hand so callers do not depend on generated stub types. */
export interface LedgerApi {
	requestClaims(req: ClaimRequest): Promise<LedgerDecision>;
	renew(intentId: IntentId): Promise<void>;
	release(intentId: IntentId, landed?: boolean): Promise<void>;
	subscribe(intentId: IntentId, premises: { symbol: SymbolId; surfaceHash: string | null }[]): Promise<void>;
	readersOf(symbols: SymbolId[]): Promise<Reader[]>;
	stalemate(a: IntentId, b: IntentId): Promise<boolean>;
	snapshot(): Promise<LedgerSnapshot>;
}

export function ledgerShard(env: LedgerEnv, shard: string): LedgerApi {
	return env.LEDGER.get(env.LEDGER.idFromName(shard)) as unknown as LedgerApi;
}

/** Groups items by the shard that owns their symbol. Shards come out in sorted order. */
export function groupByShard<T>(items: readonly T[], symbolOf: (item: T) => SymbolId): [string, T[]][] {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const shard = moduleShard(symbolOf(item));
		groups.set(shard, [...(groups.get(shard) ?? []), item]);
	}
	return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function shardsOf(symbols: readonly SymbolId[]): string[] {
	return groupByShard(symbols, (symbol) => symbol).map(([shard]) => shard);
}

/**
 * Asks every shard involved, one at a time and always in sorted shard order, so two Intents can
 * never each hold half of what the other needs. All or nothing: if any shard says no, the
 * shards that already granted are released and that decision is returned. The exception is
 * Split, where the requester keeps what the ledger gave it.
 */
export async function requestClaimsAcrossShards(env: LedgerEnv, req: ClaimRequest): Promise<LedgerDecision> {
	const groups = groupByShard(req.claims, (claim) => claim.symbol);
	const granted: string[] = [];
	for (const [shard, claims] of groups) {
		const decision = await ledgerShard(env, shard).requestClaims({ ...req, claims, elsewhere: req.claims.length - claims.length });
		if (decision.kind === "granted") {
			granted.push(shard);
			continue;
		}
		if (decision.kind !== "split") {
			await Promise.all(granted.map((name) => ledgerShard(env, name).release(req.intentId)));
		}
		return decision;
	}
	return { kind: "granted" };
}

/** Who relies on any of these symbols, across all shards. */
export async function readersAcrossShards(env: LedgerEnv, symbols: readonly SymbolId[]): Promise<Reader[]> {
	const groups = groupByShard(symbols, (symbol) => symbol);
	const results = await Promise.all(groups.map(([shard, own]) => ledgerShard(env, shard).readersOf(own)));
	return results.flat();
}

/** Records read subscriptions in whichever shards own the symbols. */
export async function subscribeAcrossShards(env: LedgerEnv, intentId: IntentId, premises: readonly { symbol: SymbolId; surfaceHash: string | null }[]): Promise<void> {
	await Promise.all(groupByShard(premises, (premise) => premise.symbol).map(([shard, own]) => ledgerShard(env, shard).subscribe(intentId, own)));
}

export async function renewEverywhere(env: LedgerEnv, intentId: IntentId, shards: readonly string[]): Promise<void> {
	await Promise.all(shards.map((shard) => ledgerShard(env, shard).renew(intentId)));
}

/** Drops an Intent's claims and subscriptions in the given shards. Pass `landed` when it reached trunk. */
export async function releaseEverywhere(env: LedgerEnv, intentId: IntentId, shards: readonly string[], landed = false): Promise<void> {
	await Promise.all(shards.map((shard) => ledgerShard(env, shard).release(intentId, landed)));
}

/** True when two Intents are stuck splitting the same symbols in any of the given shards. */
export async function isStalemateAcrossShards(env: LedgerEnv, a: IntentId, b: IntentId, shards: readonly string[]): Promise<boolean> {
	const results = await Promise.all(shards.map((shard) => ledgerShard(env, shard).stalemate(a, b)));
	return results.some(Boolean);
}
