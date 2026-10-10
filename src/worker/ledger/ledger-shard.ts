import { DurableObject } from "cloudflare:workers";
import type { ClaimMode, IntentId, LedgerDecision, SymbolId } from "../../shared/types";
import { type ClaimRequest, decide, type HeldClaim, isStalemate, type LedgerHistoryEntry } from "./decide";

export const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface Reader {
	intentId: IntentId;
	symbol: SymbolId;
	surfaceHash: string | null;
}

export interface LedgerSnapshot {
	claims: (HeldClaim & { expiresAt: number })[];
	readers: Reader[];
}

type ClaimRow = { intent_id: string; symbol: string; mode: string; since: number; priority: number; expires_at: number };
type ReaderRow = { intent_id: string; symbol: string; surface_hash: string | null };
type HistoryRow = { type: string; intent_id: string; other: string | null; kind: string | null };

const toHeld = (row: ClaimRow): HeldClaim & { expiresAt: number } => ({
	intentId: row.intent_id,
	symbol: row.symbol,
	mode: row.mode as ClaimMode,
	since: row.since,
	priority: row.priority,
	expiresAt: row.expires_at,
});

/**
 * Claims and read subscriptions for the symbols of one module directory. One instance per
 * shard name (`moduleShard()`); reach it through ledger/client.ts. All the judgement is in
 * decide.ts; this class only stores rows.
 */
export class LedgerShard extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec("CREATE TABLE IF NOT EXISTS claims(intent_id TEXT, symbol TEXT, mode TEXT, since INTEGER, priority INTEGER, expires_at INTEGER, PRIMARY KEY (intent_id, symbol))");
			sql.exec("CREATE TABLE IF NOT EXISTS readers(intent_id TEXT, symbol TEXT, surface_hash TEXT, PRIMARY KEY (intent_id, symbol))");
			sql.exec("CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, intent_id TEXT, other TEXT, kind TEXT)");
		});
	}

	private get sql(): SqlStorage {
		return this.ctx.storage.sql;
	}

	private dropExpired(now: number): void {
		this.sql.exec("DELETE FROM claims WHERE expires_at <= ?", now);
	}

	private held(): (HeldClaim & { expiresAt: number })[] {
		return this.sql.exec<ClaimRow>("SELECT intent_id, symbol, mode, since, priority, expires_at FROM claims ORDER BY since, intent_id, symbol").toArray().map(toHeld);
	}

	private async scheduleExpiry(): Promise<void> {
		const next = this.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM claims").one().at;
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
		} else {
			await this.ctx.storage.setAlarm(next);
		}
	}

	private insertClaims(req: ClaimRequest, symbols: readonly SymbolId[], now: number): void {
		const modes = new Map(req.claims.map((claim) => [claim.symbol, claim.mode]));
		for (const symbol of symbols) {
			// A symbol handed to the requester by a Split may still be held by the other side: it moves.
			this.sql.exec("DELETE FROM claims WHERE symbol = ? AND intent_id != ?", symbol, req.intentId);
			this.sql.exec(
				"INSERT INTO claims (intent_id, symbol, mode, since, priority, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(intent_id, symbol) DO UPDATE SET mode = excluded.mode, priority = excluded.priority, expires_at = excluded.expires_at",
				req.intentId,
				symbol,
				modes.get(symbol) ?? "body",
				now,
				req.priority,
				now + CLAIM_TTL_MS,
			);
		}
	}

	/** `req.claims` must already be limited to this shard's symbols (the client does that). */
	async requestClaims(req: ClaimRequest): Promise<LedgerDecision> {
		const now = Date.now();
		this.dropExpired(now);
		const decision = decide(req, this.held());

		if (decision.kind === "granted") {
			this.insertClaims(req, req.claims.map((claim) => claim.symbol), now);
		} else {
			if (decision.kind === "split") {
				const here = new Set(req.claims.map((claim) => claim.symbol));
				this.insertClaims(req, decision.proposal.mine.filter((symbol) => here.has(symbol)), now);
			}
			const other = decision.kind === "split" ? decision.with : decision.on;
			this.sql.exec("INSERT INTO history (type, intent_id, other, kind) VALUES ('decision', ?, ?, ?)", req.intentId, other, decision.kind);
		}
		await this.scheduleExpiry();
		return decision;
	}

	/** Gives the requested symbols to the requester whoever holds them now. Only a person's decision does this. */
	async seize(req: ClaimRequest): Promise<LedgerDecision> {
		const now = Date.now();
		this.dropExpired(now);
		this.insertClaims(req, req.claims.map((claim) => claim.symbol), now);
		await this.scheduleExpiry();
		return { kind: "granted" };
	}

	/** Pushes the expiry of an Intent's claims out by another ten minutes. */
	async renew(intentId: IntentId): Promise<void> {
		this.sql.exec("UPDATE claims SET expires_at = ? WHERE intent_id = ?", Date.now() + CLAIM_TTL_MS, intentId);
		await this.scheduleExpiry();
	}

	/** Drops an Intent's claims and read subscriptions. Pass `landed` when it reached trunk. */
	async release(intentId: IntentId, landed = false): Promise<void> {
		this.sql.exec("DELETE FROM claims WHERE intent_id = ?", intentId);
		this.sql.exec("DELETE FROM readers WHERE intent_id = ?", intentId);
		if (landed) {
			this.sql.exec("INSERT INTO history (type, intent_id) VALUES ('landed', ?)", intentId);
		}
		await this.scheduleExpiry();
	}

	/** Records that an Intent relies on these symbols. Replaces any earlier hash for the same symbol. */
	async subscribe(intentId: IntentId, premises: { symbol: SymbolId; surfaceHash: string | null }[]): Promise<void> {
		for (const premise of premises) {
			this.sql.exec(
				"INSERT INTO readers (intent_id, symbol, surface_hash) VALUES (?, ?, ?) ON CONFLICT(intent_id, symbol) DO UPDATE SET surface_hash = excluded.surface_hash",
				intentId,
				premise.symbol,
				premise.surfaceHash,
			);
		}
	}

	async readersOf(symbols: SymbolId[]): Promise<Reader[]> {
		const wanted = new Set(symbols);
		return this.sql
			.exec<ReaderRow>("SELECT intent_id, symbol, surface_hash FROM readers ORDER BY symbol, intent_id")
			.toArray()
			.filter((row) => wanted.has(row.symbol))
			.map((row) => ({ intentId: row.intent_id, symbol: row.symbol, surfaceHash: row.surface_hash }));
	}

	/** True when these two Intents have been told to Split twice here and neither has landed since. */
	async stalemate(a: IntentId, b: IntentId): Promise<boolean> {
		const history = this.sql
			.exec<HistoryRow>("SELECT type, intent_id, other, kind FROM history ORDER BY seq")
			.toArray()
			.map((row): LedgerHistoryEntry =>
				row.type === "landed"
					? { type: "landed", intentId: row.intent_id }
					: { type: "decision", intentId: row.intent_id, other: row.other ?? "", kind: (row.kind ?? "wait") as "wait" | "split" | "depend" },
			);
		return isStalemate(a, b, history);
	}

	/** Everything this shard holds, for the UI's ledger rail and for debugging. */
	async snapshot(): Promise<LedgerSnapshot> {
		this.dropExpired(Date.now());
		return {
			claims: this.held(),
			readers: this.sql
				.exec<ReaderRow>("SELECT intent_id, symbol, surface_hash FROM readers ORDER BY symbol, intent_id")
				.toArray()
				.map((row) => ({ intentId: row.intent_id, symbol: row.symbol, surfaceHash: row.surface_hash })),
		};
	}

	/** Forgets everything. Used when the demo is reset. */
	async clear(): Promise<void> {
		this.sql.exec("DELETE FROM claims");
		this.sql.exec("DELETE FROM readers");
		this.sql.exec("DELETE FROM history");
		await this.ctx.storage.deleteAlarm();
	}

	async alarm(): Promise<void> {
		this.dropExpired(Date.now());
		await this.scheduleExpiry();
	}
}
