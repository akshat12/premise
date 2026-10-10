// The queue consumer for Artifacts event subscriptions. Two kinds of message arrive:
//   - account-level repo events (created, forked, imported, deleted), which are relayed to the UI;
//   - pushes to trunk. A push the gate made has already been dealt with. A push from anywhere
//     else (a person with a token, say) moved trunk behind the gate's back, so the Intents in
//     flight are checked against it here, exactly as if an Intent had landed.
import type { PremiseEventBody } from "../../shared/events";
import type { CommitSha, IntentId, SymbolId } from "../../shared/types";
import { type Invalidate, invalidate } from "../gate/invalidate";
import { currentTrunk, hub, publishMany } from "../hub/publish";
import { getRepoStore } from "../ports";
import { type FileMap, isCommitSha, type RepoStore, ZERO_SHA } from "../ports/repo-store";
import { diffSurface, surface } from "../surface";

/** The parts of an Artifacts event this Worker reads. See docs/PLAN.md, "Artifacts event cheat-sheet". */
export interface ArtifactsEvent {
	type: string;
	source?: { type?: string; namespace?: string; repoName?: string };
	payload?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface TrunkPush {
	before: CommitSha;
	after: CommitSha;
	/** The Intent named in the pushed commit's `Premise-Intent:` trailer, if the gate made it. */
	byIntent: IntentId | null;
}

export interface Interpreted {
	/** Events to publish for the UI. */
	publish: PremiseEventBody[];
	/** Set when the message is a push to trunk's main branch. */
	trunkPush?: TrunkPush;
}

const PREFIX = "cf.artifacts.";
const MAIN_REF = "refs/heads/main";

export function isArtifactsEvent(body: unknown): body is ArtifactsEvent {
	return typeof body === "object" && body !== null && typeof (body as { type?: unknown }).type === "string" && (body as { type: string }).type.startsWith(PREFIX);
}

/** The Intent a landing commit names in its trailer, or null. */
export function intentFromMessage(message: string): IntentId | null {
	return /^Premise-Intent: (\S+)\s*$/m.exec(message)?.[1] ?? null;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Works out what a message means. Pure.
 *
 * Platform events are relayed as `artifacts` events whose type keeps the platform's name
 * (`repo.forked`, `repo.pushed`, ...). Those are not the types the fork and push counters count
 * (`forked`, `pushed`): our own code publishes those at the moment it forks or pushes, so the
 * counters are the same with or without event subscriptions, and nothing is counted twice.
 */
export function interpret(body: unknown, trunk: string): Interpreted {
	if (!isArtifactsEvent(body)) {
		return { publish: [] };
	}
	const type = body.type.slice(PREFIX.length); // "repo.forked", "repo.pushed", ...
	const payload = body.payload ?? {};
	const sourceRepo = body.source?.repoName ?? "";

	switch (type) {
		case "repo.forked": {
			// `source` is the repo that was forked; the payload describes the new one.
			const fork = text(payload.repoName) ?? "";
			return { publish: [{ t: "artifacts", type, repo: fork, detail: { source: sourceRepo } }] };
		}
		case "repo.created":
		case "repo.deleted":
			return { publish: [{ t: "artifacts", type, repo: sourceRepo }] };
		case "repo.imported":
			return { publish: [{ t: "artifacts", type, repo: sourceRepo, detail: { sourceUrl: text(payload.sourceUrl) ?? null } }] };
		case "repo.pushed": {
			const ref = text(payload.ref) ?? "";
			const before = text(payload.before) ?? "";
			const after = text(payload.after) ?? "";
			const commits = Array.isArray(payload.commits) ? (payload.commits as { id?: unknown; message?: unknown }[]) : [];
			const head = commits.find((commit) => commit.id === after) ?? commits.at(-1);
			const byIntent = intentFromMessage(text(head?.message) ?? "");
			const relay: PremiseEventBody = { t: "artifacts", type, repo: sourceRepo, detail: { ref, before, after, intent: byIntent } };
			if (sourceRepo !== trunk || ref !== MAIN_REF || !isCommitSha(after)) {
				return { publish: [relay] };
			}
			return { publish: [relay], trunkPush: { before, after, byIntent } };
		}
		default:
			// cloned, fetched, token events: nothing the UI shows.
			return { publish: [] };
	}
}

export interface ConsumerDeps {
	store?: RepoStore;
	invalidate?: Invalidate;
}

type ConsumerEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER" | "REPO_STORE" | "ARTIFACTS" | "TRUNK_REPO">;

/** Which symbols' type surface differs between two versions of trunk. */
export function changedBetween(before: FileMap, after: FileMap): SymbolId[] {
	const moved = diffSurface(surface(before).map, surface(after).map);
	return [...moved.changed, ...moved.removed].sort();
}

/** Handles one queue message. Returns what it did, for tests and logs. */
export async function handleArtifactsEvent(env: ConsumerEnv, body: unknown, deps: ConsumerDeps = {}): Promise<{ published: number; invalidated: boolean }> {
	const trunk = await currentTrunk(env);
	const { publish, trunkPush } = interpret(body, trunk);
	await publishMany(env, publish);
	if (trunkPush === undefined || trunkPush.before === ZERO_SHA || !isCommitSha(trunkPush.before)) {
		return { published: publish.length, invalidated: false };
	}
	if (await hub(env).isProcessed(trunkPush.after)) {
		return { published: publish.length, invalidated: false }; // the gate landed this and has already told everyone
	}
	const store = deps.store ?? getRepoStore(env);
	const [before, after] = await Promise.all([store.snapshot(trunk, trunkPush.before), store.snapshot(trunk, trunkPush.after)]);
	const result = await (deps.invalidate ?? invalidate)(env, { commit: trunkPush.after, byIntent: trunkPush.byIntent, changedSymbols: changedBetween(before, after), newTrunkFiles: after });
	return { published: publish.length, invalidated: !result.skipped };
}

/** The Worker's `queue()` handler. Every message is acknowledged: a bad one must not be redelivered forever. */
export async function consumeBatch(batch: MessageBatch<unknown>, env: ConsumerEnv): Promise<void> {
	for (const message of batch.messages) {
		try {
			await handleArtifactsEvent(env, message.body);
		} catch (error) {
			console.error("events: could not handle message", message.id, error instanceof Error ? error.message : String(error));
		} finally {
			message.ack();
		}
	}
}
