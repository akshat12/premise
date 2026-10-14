/** The parts of one mode's result (ModeResult in src/worker/ab/report.ts) that this panel reads. */
interface ModeResult {
	tasksDispatched: number;
	races: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
	agentRaces: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
}

type Rule = "baseline" | "queue" | "premise";

/** docs/ab-results.json, as scripts/ab.ts writes it: every seed run under all three landing rules. */
export interface AbResults {
	date: string;
	url: string;
	n: number;
	seeds: number[];
	headline: string;
	table: { metric: string; baseline: string; queue: string; premise: string; note?: string }[];
	trials: { seed: number; baseline: ModeResult; queue: ModeResult; premise: ModeResult }[];
}

/** The three rules, in the order they are shown: what each is called and what it does, in a sentence. */
const RULES: { key: Rule; name: string; does: string }[] = [
	{ key: "baseline", name: "Typecheck only", does: "Lands whatever rebases cleanly and compiles." },
	{ key: "queue", name: "A queue that runs the tests", does: "Also runs the tests after the rebase, and turns away what fails. This is what a careful team does today." },
	{ key: "premise", name: "Premise", does: "Also tracks what each Intent relies on, and redoes work whose premise broke." },
];

const REGRESSIONS = "Behavioural regressions that reached trunk";
const SENT_BACK = "Demo tasks sent back to a person";
const WALL_TIME = "Wall time";
const cell = { padding: "8px 16px 8px 0", verticalAlign: "top", borderTop: "1px solid var(--rule)" } as const;

/** "115.3 s to 125.6 s" as "115 to 126 seconds": whole seconds are enough for a card. */
const wholeSeconds = (value: string): string => {
	const numbers = [...value.matchAll(/(\d+(?:\.\d+)?)\s*s/g)].map((match) => Math.round(Number(match[1])));
	return numbers.length === 0 ? value : numbers.length === 1 ? `${numbers[0]} seconds` : `${numbers[0]} to ${numbers.at(-1)} seconds`;
};
/** A count that starts with 0 ("0", "0 of 12") is the good outcome. */
const none = (value: string): boolean => /^0(\D|$)/.test(value.trim());

/**
 * The same work landed under three rules, as three cards: how many problems reached trunk under
 * each, and how many tasks were handed back to a person. The full table is under "Every measurement".
 */
export function AbPanel({ results }: { results: AbResults | null }) {
	if (results === null) {
		return (
			<section aria-label="Compared" className="plane bracketed">
				<h2 className="label plane-kicker">Compared</h2>
				<p className="plane-title">No comparison has been run yet.</p>
				<p className="plane-lede">
					Run <code>npx tsx scripts/ab.ts --url &lt;worker url&gt;</code> to make one.
				</p>
			</section>
		);
	}
	const row = (metric: string) => results.table.find((candidate) => candidate.metric === metric);
	const regressions = row(REGRESSIONS);
	const sentBack = row(SENT_BACK);
	const wall = row(WALL_TIME);
	const sum = (pick: (result: ModeResult) => number) => results.trials.reduce((total, trial) => total + pick(trial.premise), 0);
	const agents = { started: sum((r) => r.agentRaces.started), rebaseWon: sum((r) => r.agentRaces.rebaseWon) };
	const workload = { started: sum((r) => r.races.started - r.agentRaces.started), rebaseWon: sum((r) => r.races.rebaseWon - r.agentRaces.rebaseWon) };
	const local = /localhost|127\.0\.0\.1/.test(results.url);
	const tasks = results.trials[0]?.baseline.tasksDispatched ?? 0;
	const runs = results.seeds.length;
	return (
		<section aria-label="Compared" className="plane bracketed">
			<h2 className="label plane-kicker">Compared</h2>
			<p className="plane-title">The same work, landed under three rules.</p>
			<p className="plane-lede">
				{tasks} agent tasks and {results.n} scripted Intents, {local ? "on a local Worker with in-memory repos" : "on real Artifacts"}
				{runs > 1 ? `, run ${runs === 3 ? "three" : runs} times with different random orderings` : ""}. One task changes how a function behaves. Three others were written against the old behaviour, so after it lands they are wrong, though they still rebase cleanly and compile.
			</p>

			<div className="rules">
				{RULES.map((rule) => {
					const reached = regressions?.[rule.key] ?? "–";
					const back = sentBack?.[rule.key] ?? "–";
					return (
						<div key={rule.key} className="rule" data-ours={rule.key === "premise"}>
							<h3 className="label rule-name">{rule.name}</h3>
							<p className="rule-does">{rule.does}</p>
							<p className="rule-reading" data-tone={none(reached) ? "good" : "accent"}>
								<span className="figure">{reached}</span>
								<span className="label">{reached.trim() === "1" ? "problem reached trunk" : "problems reached trunk"}</span>
							</p>
							<p className="rule-reading" data-tone={none(back) ? "good" : "accent"} data-size="small">
								<span className="figure">{back}</span>
								<span className="label">tasks handed back to a person</span>
							</p>
							{wall ? <p className="label rule-time">took {wholeSeconds(wall[rule.key])}</p> : null}
						</div>
					);
				})}
			</div>

			<dl className="points">
				<dt>Why a queue that runs the tests still lets one through</dt>
				<dd>One of the three tasks tests its code with a stand-in for the function that changed, as unit tests often do. Its tests still pass after the rebase. Only its premise, a check against the real function, fails.</dd>
				<dt>What Premise costs</dt>
				<dd>
					It is slower, and most of what it stops did not need stopping: {workload.rebaseWon} of the {workload.started} scripted Intents it stopped, and {agents.rebaseWon} of the {agents.started} agent Intents, passed the whole gate on a plain rebase a second
					later. Nearly all of those are changes to types. Premises are the early warning; the gate is the guarantee.
				</dd>
				<dt>What this is, and is not</dt>
				<dd>The breaking change is planted and lands first, and the agents are scripted. It shows a mechanism working. It does not measure how often this happens to a real team.</dd>
			</dl>

			<details className="more">
				<summary className="label">
					Every measurement ({results.table.length} rows, {results.seeds.length === 1 ? `seed ${results.seeds[0]}` : `seeds ${results.seeds.join(", ")}`}, {results.date})
				</summary>
				<p className="plane-small">Where the runs disagree, a cell gives the lowest and highest value.</p>
				{/* On a narrow phone the four columns are wider than the screen: the table scrolls sideways, not the page. */}
				<div style={{ overflowX: "auto" }}>
				<table style={{ marginTop: 12, fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
					<thead>
						<tr style={{ textAlign: "left" }}>
							<th scope="col" className="label" style={{ padding: "0 16px 8px 0" }}>
								Measure
							</th>
							{RULES.map((rule) => (
								<th key={rule.key} scope="col" className="label ab-value" style={{ padding: "0 16px 8px 0" }}>
									{rule.key === "queue" ? "Queue with tests" : rule.name}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{results.table.map((line) => (
							<tr key={line.metric}>
								<th scope="row" style={{ ...cell, textAlign: "left", fontWeight: line.metric === REGRESSIONS || line.metric === SENT_BACK ? 600 : 400 }}>
									{line.metric}
									{line.note ? <span style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", fontWeight: 400, marginTop: 2, maxWidth: 520 }}>{line.note}</span> : null}
								</th>
								{RULES.map((rule) => (
									<td key={rule.key} className="figure ab-figure" style={cell}>
										{line[rule.key]}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				</div>
			</details>
		</section>
	);
}
