/** The parts of one mode's result (ModeResult in src/worker/ab/report.ts) that this panel reads. */
interface ModeResult {
	tasksDispatched: number;
	races: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
	agentRaces: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
}

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

const KEY_ROWS = ["Behavioural regressions that reached trunk", "Demo tasks sent back to a person"];
const cell = { padding: "8px 16px 8px 0", verticalAlign: "top", borderTop: "1px solid var(--rule)" } as const;

/** The same work under three landing rules, side by side: typecheck only, a queue that also runs the tests, and Premise. */
export function AbPanel({ results }: { results: AbResults | null }) {
	if (results === null) {
		return (
			<section aria-label="A/B results" className="plane bracketed">
				<h2 className="label" style={{ margin: 0 }}>
				Compared: three landing rules
			</h2>
				<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
					No comparison has been run yet. Run <code>npx tsx scripts/ab.ts --url &lt;worker url&gt;</code> to make one.
				</p>
			</section>
		);
	}
	const sum = (pick: (result: ModeResult) => number) => results.trials.reduce((total, trial) => total + pick(trial.premise), 0);
	const agents = { started: sum((r) => r.agentRaces.started), rebaseWon: sum((r) => r.agentRaces.rebaseWon) };
	const workload = { started: sum((r) => r.races.started - r.agentRaces.started), rebaseWon: sum((r) => r.races.rebaseWon - r.agentRaces.rebaseWon) };
	const local = /localhost|127\.0\.0\.1/.test(results.url);
	const tasks = results.trials[0]?.baseline.tasksDispatched ?? 0;
	const seeds = results.seeds.length === 1 ? `seed ${results.seeds[0]}` : `seeds ${results.seeds.join(", ")}`;
	return (
		<section aria-label="A/B results" className="plane bracketed">
			<h2 className="label" style={{ margin: 0 }}>
				Compared: three landing rules
			</h2>
			<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)", maxWidth: 760 }}>
				The same {tasks} tasks and {results.n} scripted workload Intents ({seeds}), run under three landing rules on {results.date}, {local ? "on a local Worker with in-memory repos" : "on real Artifacts"}. The breaking change is planted and lands first in every run;
				the agents are scripted. Where the seeds disagree a cell gives the lowest and highest value.
			</p>
			<p style={{ margin: "14px 0 0", fontSize: 22, lineHeight: 1.3, fontWeight: 500, letterSpacing: "-0.01em", maxWidth: 760 }}>{results.headline}</p>
			<p style={{ margin: "16px 0 0", fontSize: 13, maxWidth: 760, borderLeft: "4px solid var(--holds)", paddingLeft: 12 }}>
				<strong>What the queue with tests misses.</strong> One of the three tasks written against the old behaviour tests its code with a stand-in for the function that changed, as unit tests often do. Its tests still pass after the rebase, so a queue
				that runs tests lands it. Only its premise, an executable assertion about the real function, is red.
			</p>
			<p style={{ margin: "12px 0 0", fontSize: 13, maxWidth: 760, borderLeft: "4px solid var(--amber)", paddingLeft: 12 }}>
				<strong>What it cost.</strong> {agents.rebaseWon} of the {agents.started} agent Intents that Premise turned stale, and {workload.rebaseWon} of the {workload.started} scripted workload Intents, then passed the whole gate on a plain rebase: for them
				the broken premise cost a second and changed nothing. Nearly all of those are type-surface changes. Premises are the early warning. The gate is the guarantee.
			</p>
			<table style={{ marginTop: 24, fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
				<thead>
					<tr style={{ textAlign: "left" }}>
						<th scope="col" className="label" style={{ padding: "0 16px 8px 0" }}>
							Measure
						</th>
						<th scope="col" className="label ab-value" style={{ padding: "0 16px 8px 0" }}>
							Typecheck only
						</th>
						<th scope="col" className="label ab-value" style={{ padding: "0 16px 8px 0" }}>
							Queue with tests
						</th>
						<th scope="col" className="label ab-value" style={{ padding: "0 16px 8px 0" }}>
							Premise
						</th>
					</tr>
				</thead>
				<tbody>
					{results.table.map((row) => (
						<tr key={row.metric}>
							<th scope="row" style={{ ...cell, textAlign: "left", fontWeight: KEY_ROWS.includes(row.metric) ? 600 : 400 }}>
								{row.metric}
								{row.note ? <span style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", fontWeight: 400, marginTop: 2, maxWidth: 520 }}>{row.note}</span> : null}
							</th>
							<td className="figure ab-figure" style={cell}>
								{row.baseline}
							</td>
							<td className="figure ab-figure" style={cell}>
								{row.queue}
							</td>
							<td className="figure ab-figure" style={cell}>
								{row.premise}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
