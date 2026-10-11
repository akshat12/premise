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
 * What the selected Intent changed, for the Drawer's `diff` prop.
 *   - Live: fetched when the Intent is selected, and again when it pushes, is queued, lands, goes
 *     stale or starts a re-derive (see `diffPhase`). The diff already on screen stays until the new one arrives.
 *   - Replay: read from the recording's `diffs` (see lib/recording.ts); there is no backend to ask.
 * "loading" while the first answer is on its way; null when there is nothing to show.
 */
export function useIntentDiff(intent: { id: IntentId; status: IntentStatus } | undefined, mode: "live" | "replay", recorded?: Readonly<Record<IntentId, IntentDiff>> | null): DiffState {
	const id = intent?.id ?? null;
	const phase = intent === undefined ? null : diffPhase(intent.status);
	const [fetched, setFetched] = useState<{ id: IntentId; diff: IntentDiff | null } | null>(null);

	useEffect(() => {
		if (mode !== "live" || id === null) {
			return;
		}
		const controller = new AbortController();
		// An aborted request is one nobody is waiting for any more: its answer is dropped.
		fetchIntentDiff(id, controller.signal).then(
			(diff) => controller.signal.aborted || setFetched({ id, diff }),
			// The Worker could not be reached.
			() => controller.signal.aborted || setFetched({ id, diff: unreadable(id) }),
		);
		return () => controller.abort();
	}, [mode, id, phase]);

	if (id === null) {
		return null;
	}
	if (mode === "replay") {
		return recorded?.[id] ?? null;
	}
	return fetched?.id === id ? fetched.diff : "loading";
}
