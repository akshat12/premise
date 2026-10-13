import { useEffect, useState } from "react";
import type { IntentId, IntentStatus } from "../../shared/types";
import { type DiffState, diffPhase, type IntentDiff, isIntentDiff, unreadable } from "./diff";

/** Asks the Worker what an Intent changed. null when the Worker has no such Intent. */
export async function fetchIntentDiff(id: IntentId, signal?: AbortSignal): Promise<IntentDiff | null> {
	const response = await fetch(`/api/intents/${encodeURIComponent(id)}/diff`, signal ? { signal } : {});
	if (response.status === 404) {
		return null;
	}
	const body: unknown = response.ok ? await response.json() : null;
	return isIntentDiff(body) ? body : unreadable(id);
}

/**
 * Asks the Worker what an Intent changed in a past run, as it landed on that run's trunk. null when
 * it did not land there: only what landed is kept once a run's forks are gone.
 */
export async function fetchLandedDiff(run: number, id: IntentId, signal?: AbortSignal): Promise<IntentDiff | null> {
	const response = await fetch(`/api/runs/${run}/intents/${encodeURIComponent(id)}/diff`, signal ? { signal } : {});
	if (response.status === 404) {
		return null;
	}
	const body: unknown = response.ok ? await response.json() : null;
	return isIntentDiff(body) ? body : unreadable(id);
}

/**
 * What the selected Intent changed, for the Drawer's `diff` prop.
 *   - Live: fetched when the Intent is selected, and again when it pushes, is queued, lands, goes
 *     stale or starts a re-derive (see `diffPhase`). The diff already on screen stays until the new one arrives.
 *   - Replay: read from the recording's `diffs` (see lib/recording.ts); there is no backend to ask.
 *   - Replay of a past run of the live board (`pastRun` is its number): fetched once when the Intent
 *     is selected. It is the Intent's landing on that run's trunk, which does not change.
 * "loading" while the first answer is on its way; null when there is nothing to show.
 */
export function useIntentDiff(intent: { id: IntentId; status: IntentStatus } | undefined, mode: "live" | "replay", recorded?: Readonly<Record<IntentId, IntentDiff>> | null, pastRun: number | null = null): DiffState {
	const id = intent?.id ?? null;
	const asked = mode === "live" || pastRun !== null;
	// A landing is the same at every moment of the replay, so there the phase asks for nothing new.
	const phase = intent === undefined || mode !== "live" ? null : diffPhase(intent.status);
	const [fetched, setFetched] = useState<{ id: IntentId; diff: IntentDiff | null } | null>(null);

	useEffect(() => {
		if (!asked || id === null) {
			return;
		}
		const controller = new AbortController();
		// An aborted request is one nobody is waiting for any more: its answer is dropped.
		(mode === "live" ? fetchIntentDiff(id, controller.signal) : fetchLandedDiff(pastRun as number, id, controller.signal)).then(
			(diff) => controller.signal.aborted || setFetched({ id, diff }),
			// The Worker could not be reached.
			() => controller.signal.aborted || setFetched({ id, diff: unreadable(id) }),
		);
		return () => controller.abort();
	}, [asked, mode, pastRun, id, phase]);

	if (id === null) {
		return null;
	}
	if (!asked) {
		return recorded?.[id] ?? null;
	}
	return fetched?.id === id ? fetched.diff : "loading";
}
