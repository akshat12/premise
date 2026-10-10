// The post-push checker. Artifacts has no pre-receive hook, so this runs after an agent has
// pushed to its own fork. It finds what the push touched, quarantines the Intent if it edited
// something it never claimed, and records what the changed code refers to as derived premises:
// the floor under premise capture, for the case where an agent reasoned from memory instead of
// reading. Nothing here can reach trunk; the gate is the guarantee.
import { parseSymbolId } from "../../shared/ids";
import type { Claim, CommitSha, Intent, IntentId, LedgerDecision, Premise, SymbolId } from "../../shared/types";
import { wakeLedgerWaiters } from "../agent/wake";
import { hub, publish, waitTopic } from "../hub/publish";
import { type IntentApi, intentStub } from "../intent/client";
import { forceClaimsAcrossShards, requestClaimsAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import type { FileMap, RepoStore } from "../ports/repo-store";
import { surface, type SurfaceMap } from "../surface";
import { indexFile, isIndexedPath, lineDiff, referencedSymbols, type Touch, touchedSymbols } from "../symbols";

export interface CheckResult {
	touched: Touch[];
	outOfClaim: SymbolId[];
	derived: SymbolId[];
}

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** Files that differ between two snapshots, ignoring the Intent's own record. */
export function changedFiles(base: FileMap, head: FileMap): string[] {
	return sorted([...Object.keys(base), ...Object.keys(head)]).filter((path) => !path.startsWith(".intent/") && base[path] !== head[path]);
}

/** What a push touched, what it touched without a claim, and what its changed code refers to. Pure. */
export function checkPush(base: FileMap, head: FileMap, claims: Claim[]): CheckResult {
	const changed = changedFiles(base, head);
	const byCode = new Map<SymbolId, Touch>();
	for (const path of changed.filter(isIndexedPath)) {
		for (const touch of touchedSymbols(path, base[path] ?? null, head[path] ?? null)) {
			byCode.set(touch.symbol, touch);
		}
	}
	const touched = [...byCode.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

	const claimed = new Map(claims.map((claim) => [claim.symbol, claim.mode]));
	// Out of claim: no claim at all, or the interface was changed under a claim that only covers the body.
	const outOfClaim = touched.filter((touch) => !claimed.has(touch.symbol) || (touch.part === "interface" && claimed.get(touch.symbol) === "body")).map((touch) => touch.symbol);

	const own = new Set<SymbolId>([...byCode.keys(), ...claimed.keys()]);
	const derived = new Set<SymbolId>();
	for (const path of changed.filter((candidate) => candidate.endsWith(".ts") && !candidate.startsWith("premise/"))) {
		const text = head[path];
		if (text === undefined) {
			continue; // a deleted file refers to nothing
		}
		const before = base[path];
		let ranges: { start: number; end: number }[] | undefined;
		if (before !== undefined) {
			// The changed lines, widened to the whole of each exported symbol they fall in: an edit
			// inside a function makes that function "the changed code", so everything it calls counts.
			ranges = lineDiff(before, text).filter((change) => change.newStart <= change.newEnd).map((change) => ({ start: change.newStart, end: change.newEnd }));
			for (const info of indexFile(path, text)) {
				if (byCode.has(info.id)) {
					ranges.push({ start: info.startLine, end: info.endLine });
				}
			}
		}
		for (const symbol of referencedSymbols(path, text, ranges)) {
			// Only source symbols can be premises; test helpers and Premise's own files have no type surface.
			if (!own.has(symbol) && isIndexedPath(parseSymbolId(symbol).path)) {
				derived.add(symbol);
			}
		}
	}
	return { touched, outOfClaim: sorted(outOfClaim), derived: sorted(derived) };
}

/** The claims needed to cover the out-of-claim touches: each at the strength the push actually used. */
export function upgradeClaims(result: CheckResult): Claim[] {
	const parts = new Map(result.touched.map((touch) => [touch.symbol, touch.part]));
	return result.outOfClaim.map((symbol) => ({ symbol, mode: parts.get(symbol) ?? "interface" }));
}

export function mergeClaims(existing: readonly Claim[], extra: readonly Claim[]): Claim[] {
	const merged = new Map(existing.map((claim) => [claim.symbol, claim]));
	for (const claim of extra) {
		if (merged.get(claim.symbol)?.mode !== "interface") {
			merged.set(claim.symbol, claim);
		}
	}
	return [...merged.values()];
}

/** Derived premises to record: symbols that exist on the base and are not already observed. */
export function derivedPremises(derived: readonly SymbolId[], baseSurface: SurfaceMap, existing: readonly Premise[]): Premise[] {
	const observed = new Set(existing.filter((premise) => premise.source === "observed").map((premise) => premise.symbol));
	return derived.flatMap((symbol): Premise[] => {
		const entry = baseSurface.get(symbol);
		return entry === undefined || observed.has(symbol) ? [] : [{ symbol, source: "derived", surfaceHash: entry.hash, state: "holding" }];
	});
}

// Computing type surfaces takes about half a second, and several Intents share a base commit.
const surfaceCache = new Map<CommitSha, SurfaceMap>();
function baseSurface(commit: CommitSha, files: FileMap): SurfaceMap {
	const cached = surfaceCache.get(commit);
	if (cached !== undefined) {
		return cached;
	}
	const map = surface(files).map;
	if (surfaceCache.size >= 8) {
		surfaceCache.delete(surfaceCache.keys().next().value as CommitSha);
	}
	surfaceCache.set(commit, map);
	return map;
}

type CheckerEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "AGENT_WORKFLOW" | "REPO_STORE" | "ARTIFACTS" | "TRUNK_REPO">;

/** What happens to an Intent that passed the checker: it goes to the gate. T15 supplies the real one. */
export type Enqueue = (intent: Intent, path: "rebase" | "rederive") => Promise<void>;

export interface CheckerDeps {
	store?: RepoStore;
	enqueue?: Enqueue;
}

const DEFAULT_PRIORITY = 5;

async function requestUpgrade(env: CheckerEnv, api: IntentApi, intent: Intent, extra: Claim[], force: boolean): Promise<LedgerDecision> {
	const request = { intentId: intent.id, claims: extra, priority: DEFAULT_PRIORITY, dependsOn: intent.dependsOn };
	const decision = force ? await forceClaimsAcrossShards(env, request) : await requestClaimsAcrossShards(env, request);
	await publish(env, { t: "claim.decision", id: intent.id, decision, symbols: extra.map((claim) => claim.symbol) });
	if (decision.kind === "granted") {
		await api.setClaims(mergeClaims(intent.claims, extra));
	}
	return decision;
}

/**
 * Checks an Intent's latest push. A fresh Intent moves from `submitted` to `queued`, or to
 * `quarantined` if it edited symbols it did not claim and the ledger will not grant them.
 * A re-derived Intent (status `rederiving`) is checked the same way but keeps its status.
 */
export async function runChecker(env: CheckerEnv, intentId: IntentId, deps: CheckerDeps = {}): Promise<CheckResult> {
	const store = deps.store ?? getRepoStore(env);
	const api = intentStub(env, intentId);
	let intent = await api.get();
	const fresh = intent.status === "submitted";
	if (fresh) {
		intent = await api.act({ a: "check" });
	}
	if (intent.headCommit === null) {
		throw new Error(`Intent ${intentId} has not pushed anything to check`);
	}

	const [base, head] = await Promise.all([store.snapshot(intent.repo, intent.baseCommit), store.snapshot(intent.repo, intent.headCommit)]);
	const result = checkPush(base, head, intent.claims);
	await publish(env, { t: "push.checked", id: intentId, commit: intent.headCommit, touched: result.touched.map((touch) => touch.symbol), outOfClaim: result.outOfClaim });
	await api.recordPremises(derivedPremises(result.derived, baseSurface(intent.baseCommit, base), intent.premises));

	if (result.outOfClaim.length > 0) {
		if (fresh) {
			await api.act({ a: "quarantine" }, `Edited without a claim: ${result.outOfClaim.join(", ")}`);
		}
		const decision = await requestUpgrade(env, api, intent, upgradeClaims(result), false);
		if (decision.kind !== "granted") {
			if (fresh) {
				const other = decision.kind === "split" ? decision.with : decision.on;
				// Re-check when the other Intent lands or fails, and let a person settle it sooner.
				await hub(env).addWaiter(`checker:${intentId}`, waitTopic.ledger(other));
				await publish(env, {
					t: "human.needed",
					id: intentId,
					kind: "stalemate",
					message: `This Intent edited ${result.outOfClaim.join(", ")}, which Intent ${other} holds.`,
					options: ["Wait", "Split", "Depend"],
				});
				return result;
			}
			// A re-derive is not quarantined: the gate decides whether its work can land.
		} else if (fresh) {
			await api.act({ a: "upgrade-granted" });
		}
	} else if (fresh) {
		await api.act({ a: "queue" });
	}
	await deps.enqueue?.(await api.get(), fresh ? "rebase" : "rederive");
	return result;
}

/**
 * Settles a quarantined Intent after a person chose, or after the Intent it was waiting on
 * finished. "Split" hands the contested symbols to this Intent, which is the one that actually
 * edited them. "Wait" and "Depend" ask the ledger again and stay quarantined if it still says no.
 */
export async function settleQuarantine(env: CheckerEnv, intentId: IntentId, choice: "Wait" | "Split" | "Depend" | "retry", deps: CheckerDeps = {}): Promise<{ status: Intent["status"]; decision: LedgerDecision | null }> {
	const store = deps.store ?? getRepoStore(env);
	const api = intentStub(env, intentId);
	const intent = await api.get();
	if (intent.status !== "quarantined" || intent.headCommit === null) {
		return { status: intent.status, decision: null };
	}
	const [base, head] = await Promise.all([store.snapshot(intent.repo, intent.baseCommit), store.snapshot(intent.repo, intent.headCommit)]);
	const result = checkPush(base, head, intent.claims);
	const extra = upgradeClaims(result);

	const decision: LedgerDecision = extra.length === 0 ? { kind: "granted" } : await requestUpgrade(env, api, intent, extra, choice === "Split");
	if (decision.kind !== "granted") {
		const other = decision.kind === "split" ? decision.with : decision.on;
		if (choice === "Depend") {
			await api.setDependsOn([...intent.dependsOn, other]);
		}
		// Still held by someone else: look again when they are done.
		await hub(env).addWaiter(`checker:${intentId}`, waitTopic.ledger(other));
		return { status: "quarantined", decision };
	}
	const queued = await api.act({ a: "upgrade-granted" }, choice === "Split" ? "The contested symbols were given to this Intent" : undefined);
	await deps.enqueue?.(queued, "rebase");
	// "Split" may have taken symbols from another Intent mid-flight; nothing waits on this one yet,
	// but anything that was waiting for those symbols can look again.
	await wakeLedgerWaiters(env, intentId).catch(() => 0);
	return { status: queued.status, decision };
}
