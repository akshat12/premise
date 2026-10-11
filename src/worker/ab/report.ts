// The A/B report: the same tasks and the same scripted workload, landed three ways, on one or
// more seeds. Pure: it turns the measurements into a table and a headline. Nothing here is
// hard-coded to a result.
import type { Metrics } from "../../shared/types";

/**
 * The three landing rules.
 *   baseline  a clean textual rebase that typechecks lands. No tests.
 *   queue     the same, and the change's own tests, its reference checks and trunk's whole suite must pass.
 *   premise   the product: the ledger, premises and invalidation, the gate, standing checks, re-derive.
 */
export type AbMode = "baseline" | "queue" | "premise";
export const AB_MODES: readonly AbMode[] = ["baseline", "queue", "premise"];

export interface RaceCounts {
	started: number;
	rebaseWon: number;
	rederiveWon: number;
	failed: number;
}

/** What one mode's run measured. */
export interface ModeResult extends Metrics {
	mode: AbMode;
	/** Scripted workload size and seed (the same in every mode of a trial). */
	n: number;
	seed: number;
	trunk: string;
	/** From the first Intent being created to the last one settling. */
	wallTimeMs: number;
	landingsPerMinute: number;
	/** How many of the demo tasks ended up on trunk, out of how many were dispatched. */
	tasksLanded: number;
	tasksDispatched: number;
	/** Where every Intent ended, agents and workload together. */
	ends: { landed: number; failed: number; escalated: number; other: number };
	/**
	 * Stale Intents and how each was settled. `rebaseWon` are the ones a plain rebase would have
	 * handled anyway: for those, going stale cost time and bought nothing.
	 */
	races: RaceCounts;
	/** The same, for the agents' Intents only. The rest of `races` is the scripted workload's. */
	agentRaces: RaceCounts;
	/** rebaseWon / started over all Intents (0 when nothing went stale). */
	falsePositiveRate: number;
	/** Work the landing rule turned away. `checks` is tests and assertions together. */
	rejected: { textConflicts: number; typecheck: number; checks: number };
	/** Scripted workload Intents that gave up because another Intent held the symbol they wanted (Premise only: the others have no ledger). */
	claimsLost: number;
	/** Reference checks and probes of landed tasks that are red on trunk at the end. */
	redReferenceTests: string[];
	/** Whether trunk typechecks at the end. */
	finalTypecheckOk: boolean;
}

/** One seed, run under all three rules. */
export interface Trial {
	seed: number;
	baseline: ModeResult;
	queue: ModeResult;
	premise: ModeResult;
}

export interface Row {
	metric: string;
	baseline: string;
	queue: string;
	premise: string;
	/** What the number means, where that is not obvious. */
	note?: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One value if every trial agrees, otherwise the lowest and the highest. */
export function spread(values: readonly string[], order: (value: string) => number = Number.parseFloat): string {
	const distinct = [...new Set(values)];
	if (distinct.length <= 1) {
		return distinct[0] ?? "";
	}
	const sorted = [...distinct].sort((a, b) => order(a) - order(b));
	return `${sorted[0]} to ${sorted.at(-1)}`;
}

/** Tasks dispatched that are not on trunk at the end: someone has to pick each one up. */
export const tasksSentBack = (result: ModeResult): number => result.tasksDispatched - result.tasksLanded;
/** Scripted workload Intents that are not on trunk at the end. */
export function workloadNotLanded(result: ModeResult): number {
	const total = result.ends.landed + result.ends.failed + result.ends.escalated + result.ends.other;
	return total - result.ends.landed - tasksSentBack(result);
}
const workloadRaces = (result: ModeResult): RaceCounts => ({
	started: result.races.started - result.agentRaces.started,
	rebaseWon: result.races.rebaseWon - result.agentRaces.rebaseWon,
	rederiveWon: result.races.rederiveWon - result.agentRaces.rederiveWon,
	failed: result.races.failed - result.agentRaces.failed,
});
const share = (races: RaceCounts) => (races.started === 0 ? "n/a" : `${percent(races.rebaseWon / races.started)} (${races.rebaseWon} of ${races.started})`);

const NAMES: Record<AbMode, string> = { baseline: "A queue that only typechecks", queue: "a queue that also runs the tests", premise: "Premise" };

export function buildReport(trials: readonly Trial[]): { table: Row[]; headline: string } {
	const each = (pick: (result: ModeResult) => string, order?: (value: string) => number): Pick<Row, AbMode> => ({
		baseline: spread(trials.map((trial) => pick(trial.baseline)), order),
		queue: spread(trials.map((trial) => pick(trial.queue)), order),
		premise: spread(trials.map((trial) => pick(trial.premise)), order),
	});
	const table: Row[] = [
		{
			metric: "Behavioural regressions that reached trunk",
			...each((r) => String(r.behaviouralRegressionsOnTrunk)),
			note: "Reference checks and end-to-end probes of landed tasks that went red after a landing. No rule runs the probes before landing; they stand for what the running system does.",
		},
		{
			metric: "Demo tasks sent back to a person",
			...each((r) => `${tasksSentBack(r)} of ${r.tasksDispatched}`),
			note: "Tasks whose work did not land and that nothing will pick up again. The two queues turn the work away and stop there. Premise re-derives it, and asks a person only after two re-derives have failed.",
		},
		{ metric: "Stale Intents redone and landed with nobody involved", ...each((r) => String(r.races.rederiveWon)), note: "Re-derives that landed. The two queues have no such step." },
		{ metric: "Broken builds on trunk", ...each((r) => String(r.brokenBuildsOnTrunk)), note: "Typecheck failures after a landing. All three rules typecheck before landing." },
		{
			metric: "Scripted workload Intents that did not land",
			...each((r) => String(workloadNotLanded(r))),
			note: "The workload aims one edit in ten at a function another edit touches, on purpose. In the two queues that becomes a text conflict for a person to merge. In Premise the ledger makes the later Intent wait, and a scripted Intent gives up after three more tries. Either way the work is not on trunk.",
		},
		{ metric: "Human merges", ...each((r) => String(r.humanMerges)), note: "Text conflicts someone has to merge by hand (the two queues), or Intents that ended with a person (Premise). A scripted Intent that gave up on a claim is not a merge, and is counted in the row above." },
		{ metric: "Intents landed", ...each((r) => `${r.intentsLanded} of ${r.ends.landed + r.ends.failed + r.ends.escalated + r.ends.other}`, (value) => Number.parseInt(value, 10)), note: "Agents and scripted workload together." },
		{ metric: "Premises broken", ...each((r) => String(r.premisesBroken)), note: "The two queues have no premises, so nobody is told." },
		{ metric: "Stale Intents a plain rebase settled", ...each((r) => String(r.races.rebaseWon)) },
		{
			metric: "False positives: agents",
			...each((r) => share(r.agentRaces)),
			note: "Of the agents' Intents that went stale, the share whose plain rebase then passed the whole gate: the broken premise cost time and changed nothing.",
		},
		{
			metric: "False positives: scripted workload",
			...each((r) => share(workloadRaces(r))),
			note: "The same for the scripted workload. These Intents have no tests or assertions of their own, so a stale one whose rebase is clean and passes trunk's suite always counts here. Read it as the cost of treating every type-surface change as a broken premise.",
		},
		{ metric: "Turned away at the gate", ...each((r) => `${r.rejected.textConflicts} text, ${r.rejected.typecheck} type, ${r.rejected.checks} checks`), note: "Text conflicts, type errors after rebase, and failed tests or assertions (the first rule runs neither)." },
		{ metric: "Gave up waiting for a claim", ...each((r) => String(r.claimsLost)), note: "Premise only: the two queues have no ledger." },
		{ metric: "Landings per minute", ...each((r) => r.landingsPerMinute.toFixed(1)) },
		{ metric: "Wall time", ...each((r) => seconds(r.wallTimeMs)) },
		{ metric: "Reference checks and probes red at the end", ...each((r) => String(r.redReferenceTests.length)) },
		{ metric: "Forks created", ...each((r) => String(r.forksCreated)) },
	];
	const sentence = (mode: AbMode): string => {
		const shipped = spread(trials.map((trial) => String(trial[mode].behaviouralRegressionsOnTrunk)));
		const back = spread(trials.map((trial) => String(tasksSentBack(trial[mode]))));
		const dispatched = trials[0]?.[mode].tasksDispatched ?? 0;
		return `${NAMES[mode]} shipped ${shipped === "1" ? "1 behavioural regression" : `${shipped} behavioural regressions`} and sent ${back} of ${plural(dispatched, "task")} back to a person`;
	};
	return { table, headline: `${AB_MODES.map(sentence).join("; ")}.` };
}

/** The report as a Markdown document. */
export function renderMarkdown(trials: readonly Trial[], meta: { date: string; source: string }): string {
	const { table, headline } = buildReport(trials);
	const first = trials[0];
	if (first === undefined) {
		return "# A/B\n\nNo run yet.\n";
	}
	const seeds = trials.map((trial) => trial.seed);
	const lines = [
		"# A/B: two queues, and Premise",
		"",
		`**${headline}**`,
		"",
		`Run on ${meta.date} against ${meta.source}. Every rule ran the same ${plural(first.baseline.tasksDispatched, "demo task")} and the same scripted workload (${first.baseline.n} Intents), each on its own fresh copy of trunk, for ${seeds.length === 1 ? `seed ${seeds[0]}` : `seeds ${seeds.join(", ")}`}.${trials.length > 1 ? " Where the seeds disagree, a cell gives the lowest and the highest value." : ""}`,
		"",
		"- **Typecheck only** lands whatever rebases cleanly and typechecks. No tests, no claims, no premises, no re-derive.",
		"- **Queue with tests** also runs the change's own tests, the task's reference checks and every test already on trunk, after the rebase. This is the fair comparison: it is what a careful team's queue does. It still has no claims, no premises and no re-derive, so what it turns away goes back to its author.",
		"- **Premise** is the full system: the ledger, premises and invalidation, the gate (typecheck, the same three kinds of test, premise assertions, the checks landed Intents left behind), and re-derive.",
		"- The rebase, the typecheck and the test runner are the same code in all three. Only the landing rule differs.",
		"",
		"## What is built into the scenario",
		"",
		"Read the table knowing how the run is set up. None of this is hidden in the code, and none of it is a measurement of real teams.",
		"",
		"- **The breaking change is planted and lands first.** One task changes how `verifySession` reports an expired session; three others are written against the old behaviour. The run holds the other eleven tasks at the gate until that one has landed, in every mode, so all three modes see the same order.",
		"- **Two of the three dependents have tests that catch it.** After the rebase their own tests fail, so a queue that runs tests turns them away just as Premise does. The difference there is what happens next: the queue stops, and Premise re-derives the work and lands it.",
		"- **The third dependent is the case tests miss, and it is built to be.** Its tests check the rate limiter with a stand-in for the session check, the way unit tests often do. The stand-in still throws, so every test passes after the rebase while the real path is broken. Only its premise (an executable assertion about the real `verifySession`) fails. An end-to-end probe that no rule runs before landing is what counts it as a regression.",
		"- **The agents here are scripted.** Their turns are generated from the reference solutions, including the assertion each dependent makes. Whether a model makes that assertion unprompted is a separate question; see the README.",
		"- **The workload's collisions are generated.** One scripted edit in ten is aimed at a function another edit touches. The row about workload Intents that did not land shows the same collisions under each rule.",
		"",
		"| | Typecheck only | Queue with tests | Premise |",
		"|---|---|---|---|",
		...table.map((row) => `| ${row.metric} | ${row.baseline} | ${row.queue} | ${row.premise} |`),
		"",
		"## What the numbers mean",
		"",
		...table.filter((row) => row.note !== undefined).map((row) => `- **${row.metric}.** ${row.note}`),
		"",
	];
	for (const trial of trials) {
		for (const mode of AB_MODES) {
			const red = trial[mode].redReferenceTests;
			if (red.length > 0) {
				lines.push(`## Red on trunk at the end: ${NAMES[mode].replace(/^a /, "A ")}, seed ${trial.seed}`, "", ...red.map((key) => `- \`${key}\``), "");
			}
		}
	}
	return lines.join("\n");
}
