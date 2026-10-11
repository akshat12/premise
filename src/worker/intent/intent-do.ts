import { DurableObject } from "cloudflare:workers";
import type { IntentSummary } from "../../shared/events";
import type { Claim, CommitSha, Intent, Premise, SymbolId } from "../../shared/types";
import { wakeLedgerWaiters } from "../agent/wake";
import { publish } from "../hub/publish";
import { releaseEverywhere, shardsOf, subscribeAcrossShards } from "../ledger/client";
import type { FileChanges } from "../ports/repo-store";
import { capture, type RpcResult } from "../rpc";
import { INTENT_METHODS } from "./client";
import { CAN_GO_STALE, type IntentAction, transition } from "./machine";
import { type BreakScope, type BrokenBy, markBroken, premisesForRederive, upsertPremise, withdrawOwn } from "./premises";

export const MAX_WHY_LINES = 3;

export function summarize(intent: Intent): IntentSummary {
	const { id, kind, taskId, goal, status, claims, premises, why, baseCommit, headCommit, rederiveAttempts } = intent;
	return { id, kind, taskId, goal, status, claims, premises, why, baseCommit, headCommit, rederiveAttempts };
}

/** Every ledger shard this Intent has rows in: where it claims, and where it reads. */
function shardsFor(intent: Intent): string[] {
	return shardsOf([...intent.claims.map((claim) => claim.symbol), ...intent.premises.map((premise) => premise.symbol)]);
}

/**
 * One Intent: its record, the files its agent is editing (the overlay), and its premises.
 * One instance per Intent id; reach it through `intentStub()` in intent/client.ts, which calls
 * `rpc()` below. Status changes go through `transition()` in machine.ts and each one publishes an event.
 */
export class IntentDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT)");
			// One row per path. `content` NULL means the agent deleted the file.
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS overlay(path TEXT PRIMARY KEY, content TEXT)");
		});
	}

	/**
	 * The one method called over RPC. It runs the named operation and returns its value or its
	 * error as data (see ../rpc.ts). Only the operations listed in INTENT_METHODS can be named.
	 */
	async rpc(method: string, args: unknown[]): Promise<RpcResult<unknown>> {
		return capture(() => {
			if (!(INTENT_METHODS as readonly string[]).includes(method)) {
				throw new Error(`IntentDO has no operation "${method}"`);
			}
			const operation = (this as unknown as Record<string, (...operationArgs: unknown[]) => unknown>)[method];
			return operation?.apply(this, args);
		});
	}

	private load(): Intent {
		const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM state WHERE key = 'intent'").toArray()[0];
		if (row === undefined) {
			throw new Error("this Intent has not been initialised");
		}
		return JSON.parse(row.value) as Intent;
	}

	private save(intent: Intent): Intent {
		const next = { ...intent, updatedAt: Date.now() };
		this.ctx.storage.sql.exec("INSERT INTO state (key, value) VALUES ('intent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next));
		return next;
	}

	/** Creates the record. This is the only place `acceptance` is ever set. */
	async init(intent: Intent): Promise<Intent> {
		if (this.ctx.storage.sql.exec("SELECT 1 FROM state WHERE key = 'intent'").toArray().length > 0) {
			throw new Error(`Intent ${intent.id} is already initialised; its acceptance checks cannot be replaced`);
		}
		const saved = this.save(intent);
		await publish(this.env, { t: "intent.created", intent: summarize(saved) });
		return saved;
	}

	async get(): Promise<Intent> {
		return this.load();
	}

	/** Applies a status change. Throws IllegalTransition if the machine does not allow it. */
	async act(action: IntentAction, note?: string): Promise<Intent> {
		const intent = this.load();
		const status = transition(intent.status, action);
		const saved = this.save({
			...intent,
			status,
			headCommit: action.a === "submit" || action.a === "land" ? action.commit : intent.headCommit,
		});
		await publish(this.env, note === undefined ? { t: "intent.status", id: saved.id, status } : { t: "intent.status", id: saved.id, status, note });
		if (status === "landed" || status === "failed") {
			await releaseEverywhere(this.env, saved.id, shardsFor(saved), status === "landed");
			// Agents that were told to wait for this Intent can ask the ledger again.
			await wakeLedgerWaiters(this.env, saved.id);
		}
		return saved;
	}

	async recordPremise(premise: Premise): Promise<Intent> {
		const intent = this.load();
		const saved = this.save({ ...intent, premises: upsertPremise(intent.premises, premise) });
		await publish(this.env, { t: "premise.recorded", id: saved.id, premise });
		if (premise.surfaceHash !== null) {
			await subscribeAcrossShards(this.env, saved.id, [{ symbol: premise.symbol, surfaceHash: premise.surfaceHash }]);
		}
		return saved;
	}

	/** Records several premises in one write. Events are still published one per premise. */
	async recordPremises(premises: Premise[]): Promise<Intent> {
		if (premises.length === 0) {
			return this.load();
		}
		const intent = this.load();
		const saved = this.save({ ...intent, premises: premises.reduce(upsertPremise, intent.premises) });
		for (const premise of premises) {
			await publish(this.env, { t: "premise.recorded", id: saved.id, premise });
		}
		const readable = premises.flatMap((premise) => (premise.surfaceHash === null ? [] : [{ symbol: premise.symbol, surfaceHash: premise.surfaceHash }]));
		await subscribeAcrossShards(this.env, saved.id, readable);
		return saved;
	}

	/**
	 * Marks premises on `symbol` broken and, if the Intent is in flight, turns it stale.
	 * `scope` narrows the break to one assertion or to given sources; by default every holding
	 * premise on the symbol breaks. Returns whether anything changed.
	 */
	async breakPremise(symbol: SymbolId, by: BrokenBy, scope?: BreakScope): Promise<{ broken: boolean; intent: Intent }> {
		const intent = this.load();
		const marked = markBroken(intent.premises, symbol, by, scope);
		if (!marked.changed) {
			return { broken: false, intent };
		}
		let saved = this.save({ ...intent, premises: marked.premises });
		await publish(this.env, { t: "premise.broken", id: saved.id, symbol, byIntent: by.intentId, commit: by.commit, reason: by.reason });
		if (CAN_GO_STALE.includes(saved.status)) {
			saved = await this.act({ a: "stale" }, by.reason);
		}
		return { broken: true, intent: saved };
	}

	/** Sets what the Intent will change. Its assertions about those same symbols are withdrawn (see `withdrawOwn`). */
	async setClaims(claims: Claim[]): Promise<Intent> {
		const intent = this.load();
		return this.save({ ...intent, claims, premises: withdrawOwn(intent.premises, claims.map((claim) => claim.symbol)).kept });
	}

	/** Why the agent is doing it this way. At most three lines are kept. */
	async setWhy(lines: string[]): Promise<Intent> {
		const why = lines.map((line) => line.trim()).filter((line) => line !== "").slice(0, MAX_WHY_LINES);
		const saved = this.save({ ...this.load(), why });
		await publish(this.env, { t: "intent.why", id: saved.id, why });
		return saved;
	}

	async addRejected(alternative: string): Promise<Intent> {
		const intent = this.load();
		return this.save({ ...intent, rejectedAlternatives: [...intent.rejectedAlternatives, alternative] });
	}

	async setDependsOn(dependsOn: string[]): Promise<Intent> {
		return this.save({ ...this.load(), dependsOn: [...new Set(dependsOn)] });
	}

	async setHead(commit: CommitSha): Promise<Intent> {
		return this.save({ ...this.load(), headCommit: commit });
	}

	async incRederive(): Promise<Intent> {
		const intent = this.load();
		return this.save({ ...intent, rederiveAttempts: intent.rederiveAttempts + 1 });
	}

	/**
	 * Points the Intent at a fresh fork for a re-derive: new repo and base commit, no head, an
	 * empty overlay, holding assertions kept, broken ones and everything it read cleared.
	 */
	async restartOn(repo: string, baseCommit: CommitSha): Promise<Intent> {
		const intent = this.load();
		this.ctx.storage.sql.exec("DELETE FROM overlay");
		return this.save({ ...intent, repo, baseCommit, headCommit: null, premises: premisesForRederive(intent.premises) });
	}

	/** Stages a file edit. `null` content stages a deletion. */
	async writeOverlay(path: string, content: string | null): Promise<void> {
		this.ctx.storage.sql.exec("INSERT INTO overlay (path, content) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content", path, content);
	}

	/** The staged content of a path: a string, `null` if deleted, or `undefined` if the agent has not touched it. */
	async readOverlay(path: string): Promise<string | null | undefined> {
		const row = this.ctx.storage.sql.exec<{ content: string | null }>("SELECT content FROM overlay WHERE path = ?", path).toArray()[0];
		return row === undefined ? undefined : row.content;
	}

	async overlay(): Promise<FileChanges> {
		const rows = this.ctx.storage.sql.exec<{ path: string; content: string | null }>("SELECT path, content FROM overlay ORDER BY path").toArray();
		return Object.fromEntries(rows.map((row) => [row.path, row.content]));
	}

	async clearOverlay(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM overlay");
	}
}
