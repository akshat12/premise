// What happens to everyone else when trunk moves. Each in-flight Intent recorded what it relies
// on; this finds the ones for whom that is no longer true and marks the premise broken, which
// turns the Intent stale. Two things can break a premise:
//   - a type-surface change to a symbol the Intent read or used (the ledger knows who reads what);
//   - an assertion the Intent made about behaviour, which is run again on the new trunk. This is
//     the break a typecheck cannot see.
import { parseSymbolId } from "../../shared/ids";
import type { Assertion, CommitSha, Intent, IntentId, IntentStatus, SymbolId } from "../../shared/types";
import { hub, publishMetrics } from "../hub/publish";
import { intentStub } from "../intent/client";
import type { BreakScope, BrokenBy } from "../intent/premises";
import { readersAcrossShards } from "../ledger/client";
import type { Reader } from "../ledger/ledger-shard";
import { mapLimit } from "../ports/git-tree";
import type { FileMap } from "../ports/repo-store";
import { type RunRequest, type RunResult, runInIsolate } from "../runner";

export interface Landed {
	/** The new trunk commit. */
	commit: CommitSha;
	/** The Intent that landed, or null when someone pushed to trunk outside the gate. */
	byIntent: IntentId | null;
	/** Exported symbols whose type surface changed or disappeared. */
	changedSymbols: SymbolId[];
	/** Trunk's files at `commit`. */
	newTrunkFiles: FileMap;
	/**
	 * When one commit carries several Intents (a batch): which of them changed which symbol.
	 * A changed symbol that is not listed is put down to `byIntent`.
	 */
	changedBy?: Record<SymbolId, IntentId>;
}

export interface Break {
	intentId: IntentId;
	symbol: SymbolId;
	reason: string;
	scope: BreakScope;
	/** The Intent that caused it, when it is not the one the whole landing is put down to. */
	by?: IntentId | null;
}

export interface InvalidateResult {
	/** True when this commit had already been dealt with, so nothing was done. */
	skipped: boolean;
	/** Premises that were marked broken by this call. */
	broken: Break[];
	/** Intents with at least one premise broken by this call. */
	intents: IntentId[];
	/** Of those, the ones this call turned stale. Whoever called is responsible for getting them re-derived. */
	stale: IntentId[];
}

export type InvalidateEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER">;
export type Invalidate = (env: InvalidateEnv, landed: Landed) => Promise<InvalidateResult>;

/**
 * What `premise.broken` carries as `byIntent` when the change did not come from an Intent
 * (someone pushed to trunk directly).
 */
export const OUTSIDE_PUSH: IntentId = "outside-the-gate";

/** A premise on an Intent in one of these states is left alone: there is nothing to tell it. */
const SETTLED: readonly IntentStatus[] = ["landed", "failed", "stale"];

const INTENT_FETCH_CONCURRENCY = 12;

const who = (byIntent: IntentId | null) => (byIntent === null ? "a push to trunk" : `intent ${byIntent}`);

/** Which observed or derived premises a set of surface changes breaks. Pure. */
export function surfaceBreaks(readers: readonly Reader[], eligible: ReadonlySet<IntentId>, byIntent: IntentId | null, changedBy: Readonly<Record<SymbolId, IntentId>> = {}): Break[] {
	const seen = new Set<string>();
	const breaks: Break[] = [];
	for (const reader of readers) {
		const key = `${reader.intentId} ${reader.symbol}`;
		const by = changedBy[reader.symbol] ?? byIntent;
		if (reader.intentId === by || !eligible.has(reader.intentId) || seen.has(key)) {
			continue;
		}
		seen.add(key);
		breaks.push({
			intentId: reader.intentId,
			symbol: reader.symbol,
			reason: `type surface of ${parseSymbolId(reader.symbol).name} changed in ${who(by)}`,
			scope: { sources: ["observed", "derived"] },
			...(by === byIntent ? {} : { by }),
		});
	}
	return breaks;
}

export interface AssertionCheck {
	/** The id the assertion runs under: `<intentId>:<assertion id>`, so two Intents' assertions never clash. */
	runId: string;
	intentId: IntentId;
	symbol: SymbolId;
	assertion: Assertion;
}

/** The holding assertions of these Intents, each under a run id that is unique across Intents. Pure. */
export function assertionChecks(intents: readonly Pick<Intent, "id" | "premises">[]): AssertionCheck[] {
	return intents.flatMap((intent) =>
		intent.premises.flatMap((premise) =>
			premise.source === "asserted" && premise.state === "holding" && premise.assertion !== undefined ? [{ runId: `${intent.id}:${premise.assertion.id}`, intentId: intent.id, symbol: premise.symbol, assertion: premise.assertion }] : [],
		),
	);
}

/** Which assertions a run on the new trunk shows to be broken. Pure. */
export function assertionBreaks(checks: readonly AssertionCheck[], run: Pick<RunResult, "assertions" | "loadError">, byIntent: IntentId | null): Break[] {
	if (run.loadError !== undefined) {
		// Trunk itself does not load, so no assertion could run. That says nothing about any premise.
		return [];
	}
	const failed = new Set(run.assertions.filter((result) => !result.ok).map((result) => result.id));
	return checks
		.filter((check) => failed.has(check.runId))
		.map((check) => ({
			intentId: check.intentId,
			symbol: check.symbol,
			reason: `assertion '${check.assertion.description}' no longer holds after ${who(byIntent)}`,
			scope: { assertionId: check.assertion.id },
		}));
}

/** Everything invalidation needs from outside, so the logic can be tested with fakes. */
export interface InvalidateDeps {
	/** True the first time it is called for a commit, false afterwards. */
	claimCommit(commit: CommitSha): Promise<boolean>;
	registry(): Promise<{ id: IntentId; status: IntentStatus }[]>;
	readersOf(symbols: readonly SymbolId[]): Promise<Reader[]>;
	/** Ids of Intents that have ever asserted a premise. */
	asserters(): Promise<IntentId[]>;
	getIntent(id: IntentId): Promise<Pick<Intent, "id" | "premises"> | null>;
	/** `stale` says whether the Intent is stale after the call. */
	breakPremise(id: IntentId, symbol: SymbolId, by: BrokenBy, scope: BreakScope): Promise<{ broken: boolean; stale?: boolean }>;
	run(req: RunRequest): Promise<RunResult>;
	publishMetrics(): Promise<unknown>;
}

export async function invalidateWith(deps: InvalidateDeps, landed: Landed): Promise<InvalidateResult> {
	if (!(await deps.claimCommit(landed.commit))) {
		return { skipped: true, broken: [], intents: [], stale: [] };
	}
	// Taken once, before anything is broken: an Intent that goes stale on a surface change in this
	// call still has its assertions checked, so it is told everything that broke.
	const eligible = new Set((await deps.registry()).filter((row) => !SETTLED.includes(row.status) && row.id !== landed.byIntent).map((row) => row.id));
	const by = (item: Break): BrokenBy => ({ intentId: (item.by === undefined ? landed.byIntent : item.by) ?? OUTSIDE_PUSH, commit: landed.commit, reason: item.reason });
	const broken: Break[] = [];
	const stale = new Set<IntentId>();
	const apply = async (breaks: readonly Break[]) => {
		for (const item of breaks) {
			const result = await deps.breakPremise(item.intentId, item.symbol, by(item), item.scope);
			if (result.broken) {
				broken.push(item);
				if (result.stale) {
					stale.add(item.intentId);
				}
			}
		}
	};

	if (landed.changedSymbols.length > 0) {
		await apply(surfaceBreaks(await deps.readersOf(landed.changedSymbols), eligible, landed.byIntent, landed.changedBy));
	}

	const asserting = (await deps.asserters()).filter((id) => eligible.has(id));
	const intents = (await mapLimit(asserting, INTENT_FETCH_CONCURRENCY, (id) => deps.getIntent(id))).filter((intent) => intent !== null);
	const checks = assertionChecks(intents);
	if (checks.length > 0) {
		// One isolate for all of them: they all run against the same files.
		const run = await deps.run({ files: landed.newTrunkFiles, tests: [], assertions: checks.map((check) => ({ ...check.assertion, id: check.runId })) });
		await apply(assertionBreaks(checks, run, landed.byIntent));
	}

	await deps.publishMetrics();
	return { skipped: false, broken, intents: [...new Set(broken.map((item) => item.intentId))], stale: [...stale] };
}

export function invalidateDeps(env: InvalidateEnv): InvalidateDeps {
	return {
		claimCommit: (commit) => hub(env).claimCommit(commit),
		registry: () => hub(env).registry(),
		readersOf: (symbols) => readersAcrossShards(env, symbols),
		asserters: () => hub(env).asserters(),
		getIntent: (id) =>
			intentStub(env, id)
				.get()
				.catch(() => null),
		async breakPremise(id, symbol, by, scope) {
			const result = await intentStub(env, id).breakPremise(symbol, by, scope);
			return { broken: result.broken, stale: result.intent.status === "stale" };
		},
		run: (req) => runInIsolate(env, req),
		publishMetrics: () => publishMetrics(env),
	};
}

/**
 * Trunk moved to `landed.commit`: break every premise that no longer holds. Safe to call twice
 * for the same commit (once from the gate, once from the platform's push event); the second
 * call does nothing.
 */
export const invalidate: Invalidate = (env, landed) => invalidateWith(invalidateDeps(env), landed);
