// Pure helpers for demo mode: cutting the idle time out of a recorded run, saying honestly how
// much was cut, and finding the moments worth jumping to. Used by scripts/compress-run.ts and
// by the player.
import type { PremiseEvent } from "../../shared/events";
import type { GateReport } from "../../shared/types";
import { callsign, OUTSIDE, symbolName } from "./view";

/** A stretch with no events longer than this is cut. */
export const MAX_GAP_MS = 4000;
/** What a cut stretch is cut down to (at least; whole seconds are cut, so up to a second more is kept). */
export const KEPT_GAP_MS = 1000;

const MARK = "⏩";

/** The marker's label for a cut of `ms`: "⏩ 2m 10s compressed". */
export function formatCut(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	const parts = [...(minutes > 0 ? [`${minutes}m`] : []), ...(seconds > 0 || minutes === 0 ? [`${seconds}s`] : [])];
	return `${MARK} ${parts.join(" ")} compressed`;
}

/** The time a marker's label stands for, in ms, or null when the label is not one of ours. */
export function parseCut(label: string): number | null {
	const match = /^⏩ (?:(\d+)m)? ?(?:(\d+)s)? compressed$/.exec(label);
	if (match === null || (match[1] === undefined && match[2] === undefined)) {
		return null;
	}
	return (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 1000;
}

export interface Compressed {
	events: PremiseEvent[];
	/** How many stretches were cut. */
	cuts: number;
	/** How much time was cut in all, in ms. */
	cutMs: number;
}

/**
 * Cuts every stretch with no events longer than `maxGapMs` down to about `keptMs`, and puts a
 * `demo.marker` where each cut was made, saying how long it was. Whole seconds are cut, so the
 * label is exact. Events are renumbered so `seq` still counts up by one. Running it twice
 * changes nothing the second time.
 */
export function compressRun(events: readonly PremiseEvent[], maxGapMs = MAX_GAP_MS, keptMs = KEPT_GAP_MS): Compressed {
	const out: PremiseEvent[] = [];
	let shift = 0;
	let cuts = 0;
	for (const [index, event] of events.entries()) {
		const previous = events[index - 1];
		const gap = previous === undefined ? 0 : event.ts - previous.ts;
		if (previous !== undefined && gap > maxGapMs && event.t !== "demo.marker" && previous.t !== "demo.marker") {
			const cut = Math.floor((gap - keptMs) / 1000) * 1000;
			if (cut > 0) {
				// The marker goes at the start of what is left of the pause, so it is on screen while nothing moves.
				out.push({ t: "demo.marker", label: formatCut(cut), seq: 0, ts: previous.ts - shift });
				shift += cut;
				cuts++;
			}
		}
		out.push({ ...event, ts: event.ts - shift });
	}
	return { events: out.map((event, index) => ({ ...event, seq: index + 1 })), cuts, cutMs: shift };
}

/**
 * When each event really happened, in ms after the first one: its place in the (possibly
 * compressed) log, plus all the time the markers before it say was cut.
 */
export function realTimes(events: readonly PremiseEvent[]): number[] {
	const start = events[0]?.ts ?? 0;
	let cut = 0;
	return events.map((event) => {
		if (event.t === "demo.marker") {
			cut += parseCut(event.label) ?? 0;
		}
		return event.ts - start + cut;
	});
}

/** Events of one kind this close together are one moment (three premises breaking on one landing). */
const SAME_MOMENT_MS = 1500;
/** What follows a moment this closely belongs to it (the status change a broken premise causes). */
const TRAIL_MS = 300;

/** The kinds of moment the → key stops at. */
export type MomentKind = "break" | "race" | "human" | "end";

/** Which kind of moment this event is, if any. `last` is whether it is the log's final `metrics` event. */
export function momentKind(event: PremiseEvent, last: boolean): MomentKind | null {
	switch (event.t) {
		// A "⏩ compressed" marker is shown where idle time was cut, but it is not part of the story: the → key passes it.
		case "premise.broken":
			return "break";
		case "rederive.race":
			return event.winner === undefined ? null : "race";
		case "human.needed":
			return "human";
		case "metrics":
			return last ? "end" : null;
		default:
			return null;
	}
}

/**
 * Where the → key takes a player that has shown `position` events: just past the next key
 * moment (an agent's premise breaking, its re-derive race won, a person needed, the final
 * numbers). What happens to scripted workload Intents is not a moment.
 * Returns how many events are shown after the jump; the whole log when nothing is left.
 */
export function nextStop(events: readonly PremiseEvent[], position: number): number {
	let lastMetrics = -1;
	for (let index = events.length - 1; index >= 0; index--) {
		if (events[index]?.t === "metrics") {
			lastMetrics = index;
			break;
		}
	}
	// The scripted workload breaks premises and runs races by the dozen. Those are the crowd, not the
	// story: only an agent's Intent makes a moment.
	const workload = new Set<string>();
	for (const event of events) {
		if (event.t === "intent.created" && event.intent.kind === "workload") {
			workload.add(event.intent.id);
		}
	}
	const kindAt = (index: number) => {
		const event = events[index];
		if (event === undefined || ((event.t === "premise.broken" || event.t === "rederive.race" || event.t === "human.needed") && workload.has(event.id))) {
			return null;
		}
		return momentKind(event, index === lastMetrics);
	};
	let at = Math.max(0, position);
	while (at < events.length && kindAt(at) === null) {
		at++;
	}
	const kind = kindAt(at);
	const first = events[at];
	if (kind === null || first === undefined) {
		return events.length;
	}
	// Take in the rest of the same moment, and whatever it caused straight away.
	let end = at;
	let anchor = first.ts;
	for (let index = at + 1; index < events.length; index++) {
		const event = events[index];
		if (event === undefined || event.ts - anchor > SAME_MOMENT_MS) {
			break;
		}
		if (kindAt(index) === kind) {
			end = index;
			anchor = event.ts;
		}
	}
	const settled = events[end]?.ts ?? anchor;
	while (end + 1 < events.length && kindAt(end + 1) === null && (events[end + 1]?.ts ?? Infinity) - settled <= TRAIL_MS) {
		end++;
	}
	return end + 1;
}

const and = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const COUNT_WORDS = ["", "", "Both", "All three", "All four", "All five"];

/**
 * One sentence about what a replay is showing: the latest key moment among the first `position`
 * events, said in plain words, or how to step through the recording when there has been none yet.
 * It is what a visitor with no README beside them reads.
 */
export function captionAt(events: readonly PremiseEvent[], position: number, opening?: string): string {
	const names = new Map<string, string>();
	const workload = new Set<string>();
	let lastMetrics = -1;
	for (const [index, event] of events.entries()) {
		if (event.t === "intent.created") {
			names.set(event.intent.id, callsign(event.intent));
			if (event.intent.kind === "workload") {
				workload.add(event.intent.id);
			}
		} else if (event.t === "metrics") {
			lastMetrics = index;
		}
	}
	const named = (id: string) => (workload.has(id) ? "a workload Intent" : (names.get(id) ?? id));
	const agents = names.size - workload.size;

	for (let index = Math.min(position, events.length) - 1; index >= 0; index--) {
		const event = events[index] as PremiseEvent;
		if ("id" in event && (event.t === "premise.broken" || event.t === "rederive.race" || event.t === "human.needed") && workload.has(event.id)) {
			continue;
		}
		const kind = momentKind(event, index === lastMetrics);
		if (kind === null) {
			continue;
		}
		if (event.t === "premise.broken") {
			// Everything the same landing broke, among the agents' Intents shown so far.
			const same = events.slice(0, position).filter((other) => other.t === "premise.broken" && other.commit === event.commit && !workload.has(other.id));
			const symbols = [...new Set(same.map((other) => (other.t === "premise.broken" ? symbolName(other.symbol) : "")))];
			const rows = [...new Set(same.map((other) => ("id" in other ? other.id : "")))].map(named).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
			const who = event.byIntent === OUTSIDE ? "A push to trunk from outside the gate" : `${named(event.byIntent).replace(/^a /, "A ")} landed and`;
			const stopped = rows.length === 1 ? "It is stopped until its work is redone." : `${COUNT_WORDS[rows.length] ?? `All ${rows.length}`} are stopped until their work is redone.`;
			// The control: an agent that read the same symbol and is not stopped, because nothing it relied on changed.
			const hit = new Set(same.map((other) => ("id" in other ? other.id : "")));
			const changed = new Set(same.map((other) => (other.t === "premise.broken" ? other.symbol : "")));
			const untouched = [...new Set(events.slice(0, position).flatMap((other) => (other.t === "premise.recorded" && changed.has(other.premise.symbol) && !hit.has(other.id) && !workload.has(other.id) && other.id !== event.byIntent ? [other.id] : [])))].map(named).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
			const control = untouched.length === 0 || untouched.length > 2 ? "" : ` ${and(untouched)} read it too, but ${untouched.length === 1 ? "relies" : "rely"} only on its type, which did not change.`;
			return `${who} changed ${and(symbols)}. ${and(rows)} had recorded that ${rows.length === 1 ? "it relies" : "they rely"} on it. ${stopped}${control}`;
		}
		if (event.t === "rederive.race") {
			if (event.winner === "rebase") {
				return `${named(event.id)}: a plain rebase passed the gate and landed. Nothing had to be redone.`;
			}
			// What the gate said about the rebase. When every test passed and only the premise failed, say so:
			// that is the case a queue that runs tests would have let through.
			let report: GateReport | undefined;
			for (let at = index - 1; at >= 0 && report === undefined; at--) {
				const other = events[at] as PremiseEvent;
				if (other.t === "gate.result" && other.report.intentId === event.id && other.report.path === "rebase" && !other.report.ok) {
					report = other.report;
				}
			}
			const onlyPremise = report !== undefined && !report.textConflict && report.typecheck.ok && report.assertions.failed.length > 0 && report.tests.failed.length + (report.reference?.failed.length ?? 0) + (report.suite?.failed.length ?? 0) === 0;
			// No report at all means there was nothing to rebase: it was stopped while its agent was still working.
			const why = event.rebase !== "fail" ? "" : report === undefined ? "it was stopped before it had pushed anything, so there was nothing to rebase. " : onlyPremise ? "after a plain rebase every test passed, but its premise no longer held, so the gate turned it back. " : "a plain rebase did not pass the gate. ";
			return `${named(event.id)}: ${why}Its agent redid the work on the new trunk (a re-derive), and that passed the gate and landed.`;
		}
		if (event.t === "human.needed") {
			return event.kind === "stalemate"
				? `${named(event.id)} edited a symbol another Intent is changing, and is held. A person may choose ${and(event.options).replace(/ and ([^ ]+)$/, " or $1")}; if nobody does, it is settled when the other Intent lands.`
				: `${named(event.id)}: its re-derive failed twice, so it is waiting for a person to choose ${and(event.options).replace(/ and ([^ ]+)$/, " or $1")}.`;
		}
		if (event.t === "metrics") {
			const m = event.metrics;
			return `The run is over: ${m.intentsLanded} Intents landed, ${m.brokenBuildsOnTrunk} broken builds on trunk, ${m.humanMerges} human merges.`;
		}
	}
	const what = opening ?? `A recorded run on real Artifacts: ${agents} ${agents === 1 ? "agent" : "agents"}${workload.size > 0 ? ` and ${workload.size} scripted workload Intents` : ""}, each on its own fork.`;
	return `${what} Step through the key moments with "Next moment" or the → key.`;
}
