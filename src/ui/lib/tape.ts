// The tape: every agent's Intent laid out over time, worked out from the event log. Pure, so the
// view only has to draw it. Times are milliseconds after the log's first event.
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, IntentStatus } from "../../shared/types";
import { parseCut } from "./demo";
import type { IntentView } from "./reduce";
import { callsign, OUTSIDE, STATUS_LOOK, symbolName } from "./view";

/**
 * What an Intent is doing over a stretch of time, as far as the tape draws it.
 * "work" is the agent planning and writing; "gate" is finished work queued at, or inside, the gate;
 * "wait" is held by the ledger; "person" is waiting for someone to choose.
 */
export type SegmentKind = "work" | "gate" | "wait" | "person" | "stale" | "rederive";

const KIND: Record<IntentStatus, SegmentKind | "end"> = {
	planning: "work",
	claiming: "work",
	working: "work",
	submitted: "work",
	checking: "work",
	queued: "gate",
	gating: "gate",
	waiting: "wait",
	quarantined: "wait",
	escalated: "person",
	stale: "stale",
	rederiving: "rederive",
	landed: "end",
	failed: "end",
};

export interface TapeSegment {
	kind: SegmentKind;
	/** Where it is drawn from and to. A stale stretch starts exactly at the landing that caused it. */
	from: number;
	to: number;
	/** Still going at the end of the log. */
	open: boolean;
	/** A few words for the bar, shown only when they fit. */
	label: string;
	/** The whole of it, for a tooltip. */
	tip: string;
	/** A race the plain rebase won: nothing had to be re-derived. */
	rebased: boolean;
}

export interface TapeRow {
	id: IntentId;
	callsign: string;
	/** The first sentence of the goal. */
	title: string;
	status: IntentStatus;
	/** How many re-derive races it has been through (the R1, R2 stamp). */
	races: number;
	segments: TapeSegment[];
	end?: { at: number; kind: "landed" | "failed"; sha: string | null };
	/** Landings that broke one of its premises: where the red line is drawn through this row. */
	hits: number[];
	/** The row in words, for a screen reader. */
	summary: string;
}

export interface TapeLanding {
	at: number;
	id: IntentId;
	/** An agent's Intent, or one of the scripted workload's. */
	agent: boolean;
	/** "T01 NULL landed at 0:25 (16368bb)". */
	tip: string;
}

export interface TapeBreak {
	/** 1, 2, 3 in time order: the number on its marker. */
	n: number;
	at: number;
	/** "T01 landed · verifySession changed". */
	flag: string;
	/** The same, said in full: who landed, what changed, who went stale. */
	sentence: string;
	/** Rows whose premise it broke. */
	rows: IntentId[];
	/** Far enough from the flag before it to be written out. */
	flagged: boolean;
}

export interface TapeWorkload {
	bucketMs: number;
	/** Workload landings in each bucket of the axis. */
	landed: number[];
	/** Whether a workload Intent went stale in that bucket. */
	stale: boolean[];
	peak: number;
}

export interface Tape {
	rows: TapeRow[];
	landings: TapeLanding[];
	breaks: TapeBreak[];
	/** Places where idle time was cut out of a recording, and how much. */
	cuts: { at: number; label: string }[];
	workload: TapeWorkload | null;
	/** Where the log has got to. */
	now: number;
	/** The right-hand end of the axis. */
	span: number;
	/** Axis marks, evenly spaced. */
	ticks: number[];
}

/** "0:57", "4:35". */
export function clock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const SPANS_MS = [60_000, 90_000, 120_000, 180_000, 300_000, 600_000];
/** "Now" is never further along the axis than this. */
const NOW_AT = 0.95;

/**
 * How much time the axis shows: the first of 1, 1½, 2, 3, 5 and 10 minutes that leaves "now" inside
 * it, then whole steps of 5 minutes. It changes in steps, never continuously, so nothing on the
 * tape slides about while a run is going.
 */
export function spanFor(now: number): number {
	const fits = SPANS_MS.find((span) => now <= span * NOW_AT);
	return fits ?? Math.ceil(now / NOW_AT / 300_000) * 300_000;
}

/** Axis marks: every 10 s up to a minute and a half, every 30 s up to five minutes, then at most ten. */
export function ticksFor(span: number): number[] {
	const step = span <= 90_000 ? 10_000 : span <= 300_000 ? 30_000 : Math.max(60_000, Math.ceil(span / 10 / 60_000) * 60_000);
	const ticks: number[] = [];
	for (let at = 0; at < span; at += step) {
		ticks.push(at);
	}
	return ticks;
}

/** A stale stretch that begins within this long of the landing that caused it is drawn from that landing. */
const SNAP_MS = 3000;
/** Two break flags closer than this share of the axis cannot both be written out. */
const FLAG_GAP = 0.24;
const WORKLOAD_BUCKET_MS = 5000;

const brief = (goal: string) => (goal.split(". ")[0] ?? goal).replace(/`/g, "").replace(/\.$/, "");
const short = (name: string) => name.split(" ")[0] ?? name;
const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

interface Stretch {
	kind: SegmentKind;
	status: IntentStatus;
	from: number;
	to: number;
	open: boolean;
	rebaseFailed: boolean;
	winner?: "rebase" | "rederive";
	on?: IntentId;
	/** What it turned into: landed, stopped, or something else. */
	then?: "landed" | "failed" | "other";
}

interface Building {
	intent: IntentView;
	done: Stretch[];
	current: Stretch | null;
	waitOn?: IntentId;
	end?: { at: number; kind: "landed" | "failed" };
}

export function buildTape(events: readonly PremiseEvent[], intents: Readonly<Record<IntentId, IntentView>>): Tape {
	const start = events[0]?.ts ?? 0;
	const at = (event: PremiseEvent) => event.ts - start;
	const now = events.length > 0 ? at(events[events.length - 1] as PremiseEvent) : 0;
	const span = spanFor(now);
	const named = (id: IntentId) => {
		const intent = intents[id];
		return intent ? callsign(intent) : id;
	};

	const building = new Map<IntentId, Building>();
	const kinds = new Map<IntentId, "agent" | "workload">();
	const landed: { at: number; id: IntentId }[] = [];
	const workloadStale: number[] = [];
	const trunkAt = new Map<string, number>();
	const broken = new Map<string, { firstSeen: number; by: IntentId; symbols: Set<string>; rows: Set<IntentId> }>();
	const cuts: { at: number; label: string }[] = [];

	const move = (row: Building, status: IntentStatus, time: number) => {
		const kind = KIND[status];
		const current = row.current;
		if (current !== null && kind === current.kind) {
			current.status = status;
			return;
		}
		if (current !== null) {
			row.done.push({ ...current, to: time, open: false, then: kind === "end" ? (status === "landed" ? "landed" : "failed") : "other" });
		}
		if (kind === "end") {
			row.current = null;
			row.end = { at: time, kind: status === "landed" ? "landed" : "failed" };
			return;
		}
		row.current = { kind, status, from: time, to: time, open: true, rebaseFailed: false, ...(kind === "wait" && row.waitOn !== undefined ? { on: row.waitOn } : {}) };
	};

	for (const event of events) {
		const time = at(event);
		switch (event.t) {
			case "intent.created": {
				kinds.set(event.intent.id, event.intent.kind === "workload" ? "workload" : "agent");
				const intent = intents[event.intent.id];
				if (event.intent.kind !== "workload" && intent !== undefined && !building.has(intent.id)) {
					const row: Building = { intent, done: [], current: null };
					building.set(intent.id, row);
					move(row, event.intent.status, time);
				}
				break;
			}
			case "intent.status": {
				if (event.status === "landed") {
					landed.push({ at: time, id: event.id });
				}
				if (event.status === "stale" && kinds.get(event.id) === "workload") {
					workloadStale.push(time);
				}
				const row = building.get(event.id);
				if (row !== undefined) {
					move(row, event.status, time);
				}
				break;
			}
			case "claim.decision": {
				const row = building.get(event.id);
				if (row !== undefined && event.decision.kind !== "granted") {
					row.waitOn = event.decision.kind === "split" ? event.decision.with : event.decision.on;
					if (row.current?.kind === "wait") {
						row.current.on = row.waitOn;
					}
				}
				break;
			}
			case "rederive.race": {
				const current = building.get(event.id)?.current;
				if (current?.kind === "rederive") {
					current.rebaseFailed ||= event.rebase === "fail";
					if (event.winner !== undefined) {
						current.winner = event.winner;
					}
				} else if (event.winner !== undefined) {
					// The winner is announced just after the Intent lands: it belongs to the stretch that has just closed.
					const closed = building.get(event.id)?.done.at(-1);
					if (closed?.kind === "rederive") {
						closed.winner = event.winner;
						closed.rebaseFailed ||= event.rebase === "fail";
					}
				}
				break;
			}
			case "trunk.advanced":
				trunkAt.set(event.commit, time);
				break;
			case "premise.broken": {
				if (!building.has(event.id)) {
					break; // the scripted workload's breaks are the crowd, not the story: they show in its own row
				}
				const entry = broken.get(event.commit) ?? { firstSeen: time, by: event.byIntent, symbols: new Set<string>(), rows: new Set<IntentId>() };
				entry.symbols.add(symbolName(event.symbol));
				entry.rows.add(event.id);
				broken.set(event.commit, entry);
				break;
			}
			case "demo.marker": {
				const cut = parseCut(event.label);
				if (cut !== null) {
					const seconds = Math.round(cut / 1000);
					cuts.push({ at: time, label: `${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`} of idle time cut here` });
				}
				break;
			}
			default:
				break;
		}
	}

	// The landings that broke an agent's premise, in time order.
	let lastFlag = -Infinity;
	const breaks: TapeBreak[] = [...broken.entries()]
		.map(([commit, entry]) => ({ when: trunkAt.get(commit) ?? entry.firstSeen, entry }))
		.sort((a, b) => a.when - b.when)
		.map(({ when, entry }, index) => {
			const symbols = [...entry.symbols];
			const what = `${symbols[0]}${symbols.length > 1 ? ` +${symbols.length - 1}` : ""} changed`;
			const outside = entry.by === OUTSIDE;
			const workload = kinds.get(entry.by) === "workload";
			const who = outside ? "Pushed to trunk outside the gate" : workload ? "Workload landed" : `${short(named(entry.by))} landed`;
			const rows = [...entry.rows].sort((a, b) => named(a).localeCompare(named(b), undefined, { numeric: true }));
			const flagged = (when - lastFlag) / span >= FLAG_GAP;
			if (flagged) {
				lastFlag = when;
			}
			const actor = outside ? "A push to trunk from outside the gate" : workload ? "A scripted workload Intent landed and" : `${named(entry.by)} landed and`;
			const sentence = `${clock(when)} · ${actor} changed ${list(symbols.slice(0, 3))}${symbols.length > 3 ? ` and ${symbols.length - 3} more` : ""}. ${list(rows.map(named))} relied on ${symbols.length === 1 ? "it" : "them"} and went stale.`;
			return { n: index + 1, at: when, flag: `${who} · ${what}`, sentence, rows, flagged };
		});
	/** The landing that made this Intent stale at `staleAt`: the latest one just before it that broke one of its premises. */
	const breakOf = (id: IntentId, staleAt: number): TapeBreak | undefined => {
		for (let index = breaks.length - 1; index >= 0; index--) {
			const line = breaks[index] as TapeBreak;
			if (line.rows.includes(id) && line.at <= staleAt && staleAt - line.at <= SNAP_MS) {
				return line;
			}
		}
		return undefined;
	};

	// Rows are in task order (T01, T02, ...), as on the lanes board, not in the order the forks happened to be made.
	const rows: TapeRow[] = [...building.values()]
		.sort((a, b) => a.intent.taskId.localeCompare(b.intent.taskId, undefined, { numeric: true }))
		.map((row) => {
			const stretches = [...row.done, ...(row.current === null ? [] : [{ ...row.current, to: now }])];
			const hits: number[] = [];
			const told: string[] = [];
			const segments: TapeSegment[] = stretches.map((stretch, index) => {
				const until = stretch.open ? "now" : clock(stretch.to);
				let from = stretch.from;
				let label = "";
				let tip = "";
				let rebased = false;
				switch (stretch.kind) {
					case "work":
						label = stretch.open ? STATUS_LOOK[stretch.status].word : "";
						tip = `Working, ${clock(stretch.from)} to ${until}`;
						break;
					case "gate":
						label = stretch.open ? "at the gate" : "";
						tip = `At the gate, ${clock(stretch.from)} to ${until}`;
						break;
					case "wait": {
						const quarantined = stretch.status === "quarantined";
						const other = stretch.on === undefined ? undefined : named(stretch.on);
						label = `${quarantined ? "quarantined" : "waiting"}${other === undefined ? "" : quarantined ? ` · waiting on ${short(other)}` : ` on ${short(other)}`}`;
						tip = `${quarantined ? "Quarantined: it edited a symbol it had not claimed" : "Waiting"}${other === undefined ? "" : `, held until ${other} lands`}, ${clock(stretch.from)} to ${until}`;
						break;
					}
					case "person":
						label = "needs you";
						tip = `Waiting for a person since ${clock(stretch.from)}`;
						told.push(`Needs you since ${clock(stretch.from)}`);
						break;
					case "stale": {
						const cause = breakOf(row.intent.id, stretch.from);
						if (cause !== undefined) {
							// Drawn from the landing itself, so the Intent visibly stops at the line. The true time is in the tip.
							from = cause.at;
							hits.push(cause.at);
						}
						label = "premise broke";
						tip = `Premise broke at ${clock(stretch.from)}${cause === undefined ? "" : `: ${cause.flag}`}`;
						told.push(`Premise broke at ${clock(stretch.from)}${cause === undefined ? "" : ` when ${cause.flag.replace(" · ", " and ")}`}`);
						break;
					}
					case "rederive": {
						rebased = stretch.winner === "rebase";
						label = stretch.open ? "re-deriving" : stretch.then === "landed" ? (rebased ? "rebased" : "re-derived") : "did not pass";
						const rebase = stretch.rebaseFailed ? "The plain rebase was turned away at the gate. " : "";
						tip = `${rebase}${stretch.open ? "Re-deriving on a fresh fork" : stretch.then === "landed" ? (rebased ? "The plain rebase passed the gate" : "The re-derive passed the gate") : "Neither the rebase nor the re-derive passed"}, ${clock(stretch.from)} to ${until}`;
						if (!stretch.open) {
							told.push(stretch.then === "landed" ? (rebased ? "Rebased" : "Re-derived") : "A re-derive did not pass");
						}
						break;
					}
				}
				// The stretch before a snapped stale one ends at the same line.
				const next = stretches[index + 1];
				const nextCause = next?.kind === "stale" ? breakOf(row.intent.id, next.from) : undefined;
				const to = nextCause === undefined ? stretch.to : Math.max(from, nextCause.at);
				return { kind: stretch.kind, from, to, open: stretch.open, label, tip, rebased };
			});
			const ended = row.end === undefined ? undefined : { ...row.end, sha: row.end.kind === "landed" ? (row.intent.headCommit ?? null) : null };
			const name = callsign(row.intent);
			const title = brief(row.intent.goal);
			const state = ended === undefined ? `${STATUS_LOOK[row.intent.status].word.replace(/^./, (letter) => letter.toUpperCase())} now` : `${ended.kind === "landed" ? "Landed" : "Failed"} at ${clock(ended.at)}`;
			return {
				id: row.intent.id,
				callsign: name,
				title,
				status: row.intent.status,
				races: row.intent.races ?? 0,
				segments,
				...(ended === undefined ? {} : { end: ended }),
				hits,
				summary: `${name}, ${title}. ${[state, ...told].join(". ")}.`,
			};
		});

	const landings: TapeLanding[] = landed.map((landing) => {
		const agent = building.has(landing.id);
		const sha = agent ? intents[landing.id]?.headCommit : null;
		return { at: landing.at, id: landing.id, agent, tip: `${agent ? named(landing.id) : "A workload Intent"} landed at ${clock(landing.at)}${sha ? ` (${sha.slice(0, 7)})` : ""}` };
	});

	const workloadLandings = landings.filter((landing) => !landing.agent);
	const hasWorkload = [...kinds.values()].includes("workload");
	const buckets = Math.ceil(span / WORKLOAD_BUCKET_MS);
	const landedIn = Array.from({ length: buckets }, () => 0);
	const staleIn = Array.from({ length: buckets }, () => false);
	const bucketOf = (time: number) => Math.min(buckets - 1, Math.floor(time / WORKLOAD_BUCKET_MS));
	for (const landing of workloadLandings) {
		const index = bucketOf(landing.at);
		landedIn[index] = (landedIn[index] ?? 0) + 1;
	}
	for (const time of workloadStale) {
		staleIn[bucketOf(time)] = true;
	}

	return {
		rows,
		landings,
		breaks,
		cuts,
		workload: hasWorkload ? { bucketMs: WORKLOAD_BUCKET_MS, landed: landedIn, stale: staleIn, peak: Math.max(1, ...landedIn) } : null,
		now,
		span,
		ticks: ticksFor(span),
	};
}

/** How many of a log's events have happened by `ms` after its first: where to move a replay to show that moment. */
export function positionAt(events: readonly PremiseEvent[], ms: number): number {
	const start = events[0]?.ts ?? 0;
	let low = 0;
	let high = events.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((events[middle] as PremiseEvent).ts - start <= ms) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return Math.max(1, low);
}
