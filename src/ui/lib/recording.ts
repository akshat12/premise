// The file a recorded run is kept in (demo/runs/<name>.json). Pure.
//
// A recording was at first just the event log, a JSON array. It can now also carry what each
// agent's Intent changed, because the forks are gone by the time it is replayed:
//   { "events": [ ...the log... ], "diffs": { "<intent id>": { ...IntentDiff... } } }
// Both forms are read. A recording with no diffs is still written as the plain array.
import type { PremiseEvent } from "../../shared/events";
import type { IntentId } from "../../shared/types";
import { type IntentDiff, isIntentDiff } from "./diff";

export interface Recording {
	events: PremiseEvent[];
	/** What each agent's Intent changed, as it stood when the run ended. Empty for a recording made before diffs were kept. */
	diffs: Record<IntentId, IntentDiff>;
}

/** Reads either form of a recording file. Anything that is not a diff is left out of `diffs`. */
export function readRecording(data: unknown): Recording {
	if (Array.isArray(data)) {
		return { events: data as PremiseEvent[], diffs: {} };
	}
	if (typeof data !== "object" || data === null || !Array.isArray((data as { events?: unknown }).events)) {
		throw new Error("not a recorded run: expected an array of events, or { events, diffs }");
	}
	const { events, diffs } = data as { events: PremiseEvent[]; diffs?: unknown };
	const kept = typeof diffs === "object" && diffs !== null ? Object.entries(diffs).filter((entry): entry is [IntentId, IntentDiff] => isIntentDiff(entry[1])) : [];
	return { events, diffs: Object.fromEntries(kept) };
}

/** The ids of the agents' Intents in a log, in the order they were created. Scripted workload Intents are not among them. */
export function agentIntentIds(events: readonly PremiseEvent[]): IntentId[] {
	return [...new Set(events.flatMap((event) => (event.t === "intent.created" && event.intent.kind === "agent" ? [event.intent.id] : [])))];
}

/**
 * The text of a recording file. One event to a line (the file diffs, and is no bigger than it has
 * to be), and one Intent's diff to a line after them.
 */
export function formatRecording(recording: Recording): string {
	const events = `[\n${recording.events.map((event) => JSON.stringify(event)).join(",\n")}\n]`;
	const diffs = Object.entries(recording.diffs);
	if (diffs.length === 0) {
		return `${events}\n`;
	}
	return `{"events":${events},\n"diffs":{\n${diffs.map(([id, diff]) => `${JSON.stringify(id)}:${JSON.stringify(diff)}`).join(",\n")}\n}}\n`;
}
