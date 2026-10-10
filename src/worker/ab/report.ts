// The A/B report: the same tasks and the same scripted workload, landed two ways. Pure: it turns
// two sets of measurements into a table and a headline. Nothing here is hard-coded to a result.
import type { Metrics } from "../../shared/types";

/** What one mode's run measured. */
export interface ModeResult extends Metrics {
	mode: "baseline" | "premise";
	/** Scripted workload size and seed (the same in both modes). */
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
	races: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
	/** rebaseWon / started (0 when nothing went stale). */
	falsePositiveRate: number;
	/** Work the landing rule turned away. */
	rejected: { textConflicts: number; typecheck: number; checks: number };
	/** Scripted workload Intents that gave up because another Intent held the symbol they wanted (Premise only: the baseline has no ledger). */
	claimsLost: number;
	/** Reference tests of landed tasks that are red on trunk at the end. */
	redReferenceTests: string[];
	/** Whether trunk typechecks at the end. */
	finalTypecheckOk: boolean;
}

export interface Row {
	metric: string;
	baseline: string;
	premise: string;
	/** What the number means, where that is not obvious. */
	note?: string;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One sentence per mode, built from the numbers. */
function sentence(name: string, result: ModeResult): string {
	const shipped = `shipped ${plural(result.behaviouralRegressionsOnTrunk, "behavioural regression")}`;
	const needed = `needed ${plural(result.humanMerges, "human merge")}`;
	return `${name} ${shipped} and ${needed}`;
}

export function buildReport(baseline: ModeResult, premise: ModeResult): { table: Row[]; headline: string } {
	const both = (pick: (result: ModeResult) => string): Pick<Row, "baseline" | "premise"> => ({ baseline: pick(baseline), premise: pick(premise) });
	const table: Row[] = [
		{ metric: "Behavioural regressions that reached trunk", ...both((r) => String(r.behaviouralRegressionsOnTrunk)), note: "Reference tests of landed tasks that went red after a landing." },
		{ metric: "Human merges", ...both((r) => String(r.humanMerges)), note: "Baseline: text conflicts someone has to merge by hand. Premise: Intents that could not move without a person, plus stalemate cards a person answered. A stalemate card that resolved by itself is not counted." },
		{ metric: "Broken builds on trunk", ...both((r) => String(r.brokenBuildsOnTrunk)), note: "Typecheck failures after a landing. Both rules typecheck before landing." },
		{ metric: "Demo tasks landed", ...both((r) => `${r.tasksLanded} of ${r.tasksDispatched}`) },
		{ metric: "Intents landed", ...both((r) => `${r.intentsLanded} of ${r.ends.landed + r.ends.failed + r.ends.escalated + r.ends.other}`), note: "Agents and scripted workload together." },
		{ metric: "Landings per minute", ...both((r) => r.landingsPerMinute.toFixed(1)) },
		{ metric: "Wall time", ...both((r) => seconds(r.wallTimeMs)) },
		{ metric: "Premises broken", ...both((r) => String(r.premisesBroken)), note: "Baseline has no premises, so nobody is told." },
		{ metric: "Stale Intents settled by re-derive", ...both((r) => String(r.races.rederiveWon)) },
		{ metric: "Stale Intents a plain rebase settled", ...both((r) => String(r.races.rebaseWon)) },
		{ metric: "False-positive rate", ...both((r) => (r.races.started === 0 ? "n/a" : percent(r.falsePositiveRate))), note: "Share of stale Intents whose plain rebase passed anyway: the premise break cost time and changed nothing." },
		{ metric: "Turned away at the gate", ...both((r) => `${r.rejected.textConflicts} text, ${r.rejected.typecheck} type, ${r.rejected.checks} checks`), note: "Text conflicts, type errors after rebase, and (Premise only) failed acceptance checks or assertions." },
		{ metric: "Gave up waiting for a claim", ...both((r) => String(r.claimsLost)), note: "Scripted workload Intents that wanted a symbol another Intent was changing, asked three more times, and stopped. In the baseline the same collisions show up as text conflicts for a person." },
		{ metric: "Reference tests red at the end", ...both((r) => String(r.redReferenceTests.length)) },
		{ metric: "Forks created", ...both((r) => String(r.forksCreated)) },
	];
	return { table, headline: `${sentence("Baseline", baseline)}; ${sentence("Premise", premise)}.` };
}

/** The report as a Markdown document. */
export function renderMarkdown(baseline: ModeResult, premise: ModeResult, meta: { date: string; source: string }): string {
	const { table, headline } = buildReport(baseline, premise);
	const lines = [
		"# A/B: how teams land work today, versus Premise",
		"",
		`**${headline}**`,
		"",
		`Run on ${meta.date} against ${meta.source}. Both modes ran the same ${plural(baseline.tasksDispatched, "demo task")} and the same scripted workload (${baseline.n} Intents, seed ${baseline.seed}), each on its own fresh copy of trunk.`,
		"",
		"- **Baseline** is a modern queue with a typecheck: fork, push, and land if the textual rebase is clean and the result typechecks. No claims, no premises, no re-derive.",
		"- **Premise** is the full system: the ledger, premises and invalidation, the gate (typecheck, acceptance tests, assertions, landed checks), and re-derive.",
		"- The rebase function and the typecheck are the same code in both. Only the landing rule differs.",
		"",
		"| | Baseline | Premise |",
		"|---|---|---|",
		...table.map((row) => `| ${row.metric} | ${row.baseline} | ${row.premise} |`),
		"",
		"## What the numbers mean",
		"",
		...table.filter((row) => row.note !== undefined).map((row) => `- **${row.metric}.** ${row.note}`),
		"",
	];
	for (const [name, result] of [["Baseline", baseline], ["Premise", premise]] as const) {
		if (result.redReferenceTests.length > 0) {
			lines.push(`## Reference tests red on trunk at the end (${name})`, "", ...result.redReferenceTests.map((key) => `- \`${key}\``), "");
		}
	}
	return lines.join("\n");
}
