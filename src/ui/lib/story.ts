// The story of a run, in a handful of plain steps. Pure: everything here is read from the event
// log, so the words on screen are about what happened and cannot drift from it.
//
// A step is a place in the log (how many events are shown), a sentence, a line or two under it,
// and the Intents it is about. The front page walks through them with Back and Next while the
// tape moves to each place.
import type { PremiseEvent } from "../../shared/events";
import type { GateReport, IntentId, SymbolId } from "../../shared/types";
import { nextStop } from "./demo";
import { symbolName } from "./view";

export interface StoryStep {
	/** Stable within one log: used as a React key and to remember where the reader is. */
	id: string;
	/** How many events of the log are on screen at this step. */
	at: number;
	title: string;
	body: string;
	/** The Intents this step is about. Empty means all of them. */
	focus: IntentId[];
	/** For a step about work whose tests all passed: what the gate ran, and the premise that failed. */
	checks?: { intentId: IntentId; own: number; reference: number; suite: number; premise: string };
}

export interface Story {
	steps: StoryStep[];
	/** "Agent 1", "Agent 2", … for each agent's Intent, numbered in task order. */
	names: Record<IntentId, string>;
	/** A one-line note for a row that needs one at the end of the story ("not affected", say). */
	notes: Record<IntentId, string>;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
/** "Four" for 4, "16" for 16. */
export const countWord = (count: number): string => WORDS[count] ?? String(count);
const lowerWord = (count: number) => countWord(count).toLowerCase();
const list = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The first sentence of a goal, without code ticks or bracketed asides, short enough for a row label. */
export function jobLine(goal: string, limit = 96): string {
	const first = (goal.split(/(?<=[.!?])\s/)[0] ?? goal)
		.replace(/\s*\([^)]*\)/g, "")
		.replace(/`/g, "")
		.replace(/\.$/, "")
		.trim();
	if (first.length <= limit) {
		return first;
	}
	const cut = first.slice(0, limit);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit - 20))}…`;
}

type Outcome = "tests" | "premise" | "unpushed" | "open";

interface Stopped {
	id: IntentId;
	outcome: Outcome;
	report?: GateReport;
	/** The index of the event that settled it (its re-derive landing), or -1 if it never landed. */
	settledAt: number;
	premise: string;
}

const onlyPremise = (report: GateReport) => !report.textConflict && report.typecheck.ok && report.assertions.failed.length > 0 && report.tests.failed.length + (report.reference?.failed.length ?? 0) + (report.suite?.failed.length ?? 0) === 0;

/** Steps for a log with no landing that broke an agent's premise: one per key moment, in the log's own words. */
function plainSteps(events: readonly PremiseEvent[], caption: (position: number) => string): StoryStep[] {
	const steps: StoryStep[] = [{ id: "start", at: 0, title: caption(0), body: "", focus: [] }];
	for (let at = nextStop(events, 0); steps.length < 40; at = nextStop(events, at)) {
		steps.push({ id: `at-${at}`, at, title: caption(at), body: "", focus: [] });
		if (at >= events.length) {
			break;
		}
	}
	return steps;
}

/**
 * The story of a log. `caption` supplies a sentence for a place in the log when the run does not
 * have the shape the story is written for (one landing that breaks other agents' premises).
 */
export function storyFor(events: readonly PremiseEvent[], caption: (position: number) => string = () => ""): Story {
	const agents = events.flatMap((event) => (event.t === "intent.created" && event.intent.kind === "agent" ? [event.intent] : []));
	const ordered = [...agents].sort((a, b) => a.taskId.localeCompare(b.taskId, undefined, { numeric: true }));
	const names: Record<IntentId, string> = Object.fromEntries(ordered.map((intent, index) => [intent.id, `Agent ${index + 1}`]));
	const isAgent = (id: string) => names[id] !== undefined;
	const name = (id: IntentId) => names[id] ?? id;
	const notes: Record<IntentId, string> = {};
	if (events.length === 0 || agents.length === 0) {
		return { steps: [], names, notes };
	}

	// The landing the story turns on: the first one, by an agent, that broke another agent's premise.
	const breakIndex = events.findIndex((event) => event.t === "premise.broken" && isAgent(event.id) && isAgent(event.byIntent));
	const first = breakIndex === -1 ? undefined : events[breakIndex];
	if (first === undefined || first.t !== "premise.broken") {
		return { steps: plainSteps(events, caption), names, notes };
	}
	const lander = first.byIntent;
	const commit = first.commit;
	const broken = events.flatMap((event, index) => (event.t === "premise.broken" && event.commit === commit && isAgent(event.id) ? [{ index, id: event.id, symbol: event.symbol, reason: event.reason }] : []));
	const stoppedIds = [...new Set(broken.map((item) => item.id))];
	const symbols = [...new Set(broken.map((item) => symbolName(item.symbol)))];
	const changedSymbols = new Set<SymbolId>(broken.map((item) => item.symbol));
	const what = list(symbols);

	const landingIndex = events.findIndex((event) => event.t === "trunk.advanced" && event.commit === commit);
	const landing = landingIndex === -1 ? undefined : events[landingIndex];
	const typesChanged = landing?.t === "trunk.advanced" && landing.changedSymbols.length > 0;
	// Everything the landing broke, and each stopped Intent's change of status, which follows within a moment
	// (other events can fall in between, so it is looked for by Intent, not by position).
	let stoppedAt = (broken.at(-1)?.index ?? breakIndex) + 1;
	for (const id of stoppedIds) {
		const from = broken.find((item) => item.id === id)?.index ?? breakIndex;
		const told = events.findIndex((event, index) => index > from && event.t === "intent.status" && event.id === id && event.status === "stale");
		if (told !== -1 && (events[told]?.ts ?? 0) - (events[from]?.ts ?? 0) < 3000) {
			stoppedAt = Math.max(stoppedAt, told + 1);
		}
	}

	// What became of each stopped Intent.
	const stopped: Stopped[] = stoppedIds.map((id) => {
		let report: GateReport | undefined;
		let settledAt = -1;
		for (let index = breakIndex; index < events.length; index++) {
			const event = events[index] as PremiseEvent;
			if (event.t === "gate.result" && event.report.intentId === id && event.report.path === "rebase" && !event.report.ok && report === undefined) {
				report = event.report;
			} else if (event.t === "rederive.race" && event.id === id && event.winner !== undefined) {
				settledAt = index + 1;
				break;
			}
		}
		const reason = broken.find((item) => item.id === id)?.reason ?? "";
		const premise = /^assertion '(.+)' no longer holds/.exec(reason)?.[1] ?? reason;
		const outcome: Outcome = settledAt === -1 ? "open" : report === undefined ? "unpushed" : onlyPremise(report) ? "premise" : "tests";
		return { id, outcome, ...(report === undefined ? {} : { report }), settledAt, premise };
	});

	// The control: agents that had the changed symbol on their list and were not stopped.
	// An agent some later landing stopped is not "not affected", even though this one left it alone.
	const everStopped = new Set(events.flatMap((event) => (event.t === "premise.broken" ? [event.id] : [])));
	const untouched = [
		...new Set(
			events
				.slice(0, stoppedAt)
				.flatMap((event) => (event.t === "premise.recorded" && changedSymbols.has(event.premise.symbol) && isAgent(event.id) && event.id !== lander && !stoppedIds.includes(event.id) && !everStopped.has(event.id) ? [event.id] : [])),
		),
	];
	for (const id of untouched) {
		notes[id] = "not affected";
	}

	// Where the first two steps sit: once every agent is at work, and just before the landing.
	const working = new Set<IntentId>();
	let allWorking = 0;
	for (const [index, event] of events.entries()) {
		if (event.t === "intent.status" && event.status === "working" && isAgent(event.id)) {
			working.add(event.id);
			if (working.size === agents.length) {
				allWorking = index + 1;
				break;
			}
		}
	}
	const landerGate = events.findIndex((event) => event.t === "intent.status" && event.id === lander && event.status === "gating");
	const beforeLanding = Math.max(allWorking, landerGate === -1 ? breakIndex : landerGate);
	const startAt = Math.min(allWorking === 0 ? beforeLanding : allWorking, beforeLanding);

	const steps: StoryStep[] = [
		{
			id: "start",
			at: startAt,
			title: `${countWord(agents.length)} ${agents.length === 1 ? "agent starts" : "agents start"} work on the same code at the same time.`,
			body: "Each works in its own copy, a fork on Cloudflare Artifacts. Premise calls each agent's task an Intent.",
			focus: [],
		},
		{
			id: "premises",
			at: beforeLanding,
			title: "Premise records what each one relies on.",
			body: "Whatever an agent reads or calls goes on its list. It can also state a behaviour it depends on, as a check that can be run. Those are its premises.",
			focus: [],
		},
		{
			id: "landing",
			at: breakIndex,
			// In a run with a scripted workload, one of its Intents can reach trunk before any agent does.
			title: `${name(lander)} ${events.slice(0, breakIndex).some((event) => event.t === "intent.status" && event.status === "landed" && event.id !== lander) ? "is the first agent to land" : "lands first"}. It changed ${what}.`,
			body: `Its work is now in the shared code, which Premise calls trunk.${typesChanged ? "" : " The types did not change, so everything still compiles."}`,
			focus: [lander],
		},
		{
			id: "stopped",
			at: stoppedAt,
			title:
				stoppedIds.length === 1
					? `${name(stoppedIds[0] as IntentId)} relied on how it used to behave. It is stopped at once.`
					: `${countWord(stoppedIds.length)} agents relied on how it used to behave. They are stopped at once.`,
			body: `Each is told what changed and who changed it.${untouched.length > 0 && untouched.length <= 3 ? ` ${list(untouched.map(name))} read it too, but ${untouched.length === 1 ? "relies" : "rely"} only on its type, so ${untouched.length === 1 ? "it carries" : "they carry"} on.` : ""}`,
			focus: stoppedIds,
		},
	];

	const REDONE = "A stopped Intent first tries a plain rebase. That did not pass the gate, so its agent did the work again on the new trunk. That is a re-derive.";
	const RESTARTED = "There was nothing pushed to rebase, so the agent did the work again from the stored goal, on the new trunk. That is a re-derive.";
	const settled = stopped.filter((item) => item.outcome !== "open").sort((a, b) => a.settledAt - b.settledAt);
	const one = (item: Stopped): StoryStep => {
		const who = name(item.id);
		if (item.outcome === "premise" && item.report !== undefined) {
			return {
				id: `redone-${item.id}`,
				at: item.settledAt,
				title: `${who}'s tests all still pass. Only its premise caught the problem.`,
				body: "A check that only runs tests would have let this work through, broken. A premise is a check against the real code, so it failed, and the work was redone and landed.",
				focus: [item.id],
				checks: { intentId: item.id, own: item.report.tests.passed.length, reference: item.report.reference?.passed.length ?? 0, suite: item.report.suite?.passed ?? 0, premise: item.premise },
			};
		}
		if (item.outcome === "unpushed") {
			return { id: `redone-${item.id}`, at: item.settledAt, title: `${who} was stopped while still working. It started again on the new code and landed.`, body: RESTARTED, focus: [item.id] };
		}
		return { id: `redone-${item.id}`, at: item.settledAt, title: `${who}'s tests fail on the new code. Its work is redone and lands.`, body: REDONE, focus: [item.id] };
	};
	if (settled.length <= 3) {
		steps.push(...settled.map(one));
	} else {
		// Many were stopped: one step for each way it went, so the story stays short.
		const kinds: [Outcome, (count: number) => string, string][] = [
			["tests", (count) => `${countWord(count)} of them failed their tests on the new code. Their work was redone and landed.`, REDONE],
			["unpushed", (count) => `${countWord(count)} were stopped while still working. They started again on the new code and landed.`, RESTARTED],
			["premise", (count) => `${countWord(count)} passed every test. Only their premises caught the problem.`, "A check that only runs tests would have let that work through, broken. A premise is a check against the real code, so it failed, and the work was redone and landed."],
		];
		for (const [outcome, title, body] of kinds) {
			const group = settled.filter((item) => item.outcome === outcome);
			if (group.length === 1) {
				steps.push(one(group[0] as Stopped));
			} else if (group.length > 1) {
				steps.push({ id: `redone-${outcome}`, at: Math.max(...group.map((item) => item.settledAt)), title: title(group.length), body, focus: group.map((item) => item.id) });
			}
		}
	}

	// The end: the last numbers the log has.
	let metrics: Extract<PremiseEvent, { t: "metrics" }>["metrics"] | undefined;
	const statuses = new Map<IntentId, string>();
	for (const event of events) {
		if (event.t === "metrics") {
			metrics = event.metrics;
		} else if (event.t === "intent.status") {
			statuses.set(event.id, event.status);
		}
	}
	const landed = agents.filter((intent) => statuses.get(intent.id) === "landed").length;
	const everyone = [...statuses.values()];
	const notLanded = everyone.filter((status) => status !== "landed").length - (agents.length - landed);
	const regressions = metrics?.behaviouralRegressionsOnTrunk ?? 0;
	const wrong = regressions + (metrics?.brokenBuildsOnTrunk ?? 0);
	const open = stopped.filter((item) => item.outcome === "open");
	const allAgents = landed === agents.length;
	const title =
		wrong > 0
			? `The run is over. ${countWord(wrong)} ${wrong === 1 ? "problem" : "problems"} reached trunk.`
			: !allAgents
				? `The run is over. ${landed} of ${agents.length} agents' Intents landed.`
				: notLanded > 0
					? `All ${lowerWord(agents.length)} agents' work landed. Nothing broken reached trunk.`
					: "Everything landed. Nothing broken reached trunk.";
	const total = metrics?.intentsLanded ?? landed;
	const builds = metrics?.brokenBuildsOnTrunk ?? 0;
	const people = metrics?.humanMerges ?? 0;
	steps.push({
		id: "end",
		at: events.length,
		title,
		body: [
			`${total} ${total === 1 ? "Intent" : "Intents"} landed, ${builds} broken ${builds === 1 ? "build" : "builds"} on trunk, ${people === 0 ? "nobody was" : people === 1 ? "1 person was" : `${people} people were`} needed.`,
			regressions > 0 ? `${regressions === 1 ? "A check of what the running system does" : `${countWord(regressions)} checks of what the running system does`} failed after a landing: redone work can pass every test and still be wrong.` : "",
			notLanded > 0 ? `${notLanded} scripted workload ${notLanded === 1 ? "Intent" : "Intents"} did not land.` : "",
			open.length > 0 ? `${list(open.map((item) => name(item.id)))} did not land.` : "",
		]
			.filter(Boolean)
			.join(" "),
		focus: [],
	});

	// Steps are walked in the log's order, and no two share a place.
	// The end is the only step at the very end of the log: one that settled on the last event sits just before it.
	for (const step of steps) {
		if (step.id !== "end") {
			step.at = Math.min(step.at, Math.max(0, events.length - 1));
		}
	}
	steps.sort((a, b) => a.at - b.at);
	return { steps: steps.filter((step, index) => index === 0 || step.at > (steps[index - 1]?.at ?? -1) || step.id === "stopped" || step.id === "end"), names, notes };
}

/** The step a place in the log belongs to: the last one that has been reached. -1 before the first. */
export function stepAt(steps: readonly StoryStep[], position: number): number {
	let found = -1;
	for (const [index, step] of steps.entries()) {
		if (step.at <= position) {
			found = index;
		}
	}
	return found;
}
