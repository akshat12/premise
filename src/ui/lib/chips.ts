// What the details panel and a row's small indicators show, worked out from the view state and the
// event log. Pure.
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, Premise } from "../../shared/types";
import type { IntentView, ViewState } from "./reduce";
import { STATUS_LOOK, symbolName } from "./view";

export const SOURCE_ORDER: readonly Premise["source"][] = ["asserted", "derived", "observed"];

/** How each kind of premise is described to the person reading. */
export const SOURCE_TITLE: Record<Premise["source"], { title: string; means: string }> = {
	asserted: { title: "Asserted", means: "It depends on this behaviour, and said so with a check that runs." },
	derived: { title: "Derived", means: "Its code calls or mentions this." },
	observed: { title: "Observed", means: "It read this while planning." },
};

export interface PremiseGroup {
	source: Premise["source"];
	premises: Premise[];
	broken: number;
}

/** An Intent's premises grouped by where they came from, broken ones first within each group, then by name. */
export function groupPremises(premises: readonly Premise[]): PremiseGroup[] {
	return SOURCE_ORDER.map((source) => {
		const own = premises
			.filter((premise) => premise.source === source)
			.sort((a, b) => Number(b.state === "broken") - Number(a.state === "broken") || (symbolName(a.symbol) < symbolName(b.symbol) ? -1 : 1));
		return { source, premises: own, broken: own.filter((premise) => premise.state === "broken").length };
	}).filter((group) => group.premises.length > 0);
}

export type RaceMark = "pending" | "pass" | "fail";

export interface RaceRows {
	rebase: RaceMark;
	rederive: RaceMark;
	winner?: "rebase" | "rederive";
}

/** The two-row race indicator, or null when the Intent has never been in a race. */
export function raceRows(intent: Pick<IntentView, "race">): RaceRows | null {
	const race = intent.race;
	return race === undefined ? null : race.winner === undefined ? { rebase: race.rebase, rederive: race.rederive } : { rebase: race.rebase, rederive: race.rederive, winner: race.winner };
}

export interface TimelineEntry {
	seq: number;
	ts: number;
	text: string;
	tone: "plain" | "good" | "bad" | "rederive" | "wait";
	/** Another Intent this entry is about (the one that broke a premise, say). */
	other?: IntentId;
}

const TONE_OF_BAND = { "ink-soft": "plain", holds: "good", redpen: "bad", redo: "rederive" } as const;

/** One Intent's story from the event log, newest first: status changes, broken premises, gate verdicts and race results. */
export function timelineFor(events: readonly PremiseEvent[], id: IntentId, describe: (assertionId: string) => string | undefined = () => undefined): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	for (const event of events) {
		const base = { seq: event.seq, ts: event.ts };
		if (event.t === "intent.status" && event.id === id) {
			const look = STATUS_LOOK[event.status];
			entries.push({ ...base, text: event.note ? `${capital(look.word)}: ${event.note}` : capital(look.word), tone: TONE_OF_BAND[look.band] });
		} else if (event.t === "premise.broken" && event.id === id) {
			entries.push({ ...base, text: `Premise broke: ${event.reason}`, tone: "bad", other: event.byIntent });
		} else if (event.t === "gate.result" && event.report.intentId === id) {
			const report = event.report;
			const what = report.path === "rederive" ? "the re-derived work" : "the rebased work";
			const why = report.unchanged !== undefined && report.unchanged.length > 0
				? `it is the same change as the work that was stopped (${report.unchanged.join(", ")}), so it was not run`
				: report.textConflict
				? "text conflict"
				: !report.typecheck.ok
					? "type error"
					: [
							...report.assertions.failed.map((failure) => `its premise no longer holds (${describe(failure.id) ?? failure.id})`),
							...report.tests.failed.map((failure) => `"${failure.name}" fails`),
							...(report.reference?.failed ?? []).map((failure) => `reference check "${failure.name}" fails`),
							...(report.suite?.failed ?? []).map((failure) => `it breaks a test already on trunk (${failure.name})`),
						].join("; ");
			// When only the premise failed, say so: every test passed, and tests alone would have let this land.
			const onlyPremise = !report.ok && !report.textConflict && report.typecheck.ok && report.assertions.failed.length > 0 && report.tests.failed.length + (report.reference?.failed.length ?? 0) + (report.suite?.failed.length ?? 0) === 0;
			const ran = [
				`${report.tests.passed.length} acceptance checks`,
				...(report.reference ? [`${report.reference.passed.length} reference checks`] : []),
				...(report.suite ? [`${report.suite.passed} tests already on trunk`] : []),
			].join(", ");
			entries.push({ ...base, text: report.ok ? `Gate passed ${what} (${ran})` : `Gate turned back ${what}: ${why}${onlyPremise ? `. Every test passed (${ran})` : ""}`, tone: report.ok ? "good" : "bad" });
		} else if (event.t === "rederive.race" && event.id === id) {
			const text =
				event.winner !== undefined
					? event.winner === "rebase"
						? "The plain rebase passed the gate: nothing had to be redone"
						: "The re-derive passed the gate"
					: event.rebase === "pending" && event.rederive === "pending"
						? "Trying a plain rebase first"
						: event.rebase === "fail" && event.rederive === "fail"
							? "Neither the rebase nor the re-derive passed"
							: event.rebase === "fail"
								? "The rebase did not pass; re-deriving on a fresh fork"
								: "Re-derive update";
			entries.push({ ...base, text, tone: event.winner !== undefined ? "good" : event.rederive === "fail" ? "bad" : "rederive" });
		} else if (event.t === "claim.decision" && event.id === id && event.decision.kind !== "granted") {
			const decision = event.decision;
			const other = decision.kind === "split" ? decision.with : decision.on;
			entries.push({ ...base, text: `Ledger said ${capital(decision.kind)} for ${event.symbols.map(symbolName).join(", ")}`, tone: "wait", other });
		} else if (event.t === "human.needed" && event.id === id) {
			entries.push({ ...base, text: `Asked a person: ${event.message}`, tone: "wait" });
		} else if (event.t === "human.resolved" && event.id === id) {
			entries.push({ ...base, text: `A person chose ${event.choice}`, tone: "plain" });
		}
	}
	return entries.reverse();
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "12s ago", "3m ago". `now` is the time of the latest event on screen, so a replay reads correctly. */
export function ago(ts: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - ts) / 1000));
	if (seconds < 1) {
		return "just now";
	}
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.floor(seconds / 60);
	return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

/** Intents with a card open for a person: asked, not answered, and still stuck. */
export function openCards(state: ViewState): IntentView[] {
	return Object.values(state.intents).filter((intent) => intent.human !== undefined && intent.human.resolved === undefined && (intent.status === "escalated" || intent.status === "quarantined"));
}
