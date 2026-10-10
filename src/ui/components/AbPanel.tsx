/** The parts of one mode's result (ModeResult in src/worker/ab/report.ts) that this panel reads. */
interface ModeResult {
	tasksDispatched: number;
	falsePositiveRate: number;
	races: { started: number; rebaseWon: number; rederiveWon: number; failed: number };
}

/** docs/ab-results.json, as scripts/ab.ts writes it. */
export interface AbResults {
	date: string;
	url: string;
	n: number;
	seed: number;
	headline: string;
	table: { metric: string; baseline: string; premise: string; note?: string }[];
	baseline: ModeResult;
	premise: ModeResult;
}

const FALSE_POSITIVES = "False-positive rate";
const cell = { padding: "8px 16px 8px 0", verticalAlign: "top", borderTop: "1px solid var(--rule)" } as const;

/** The same work under two rules, side by side: plain text rebase (baseline) and Premise. */
export function AbPanel({ results }: { results: AbResults | null }) {
	if (results === null) {
		return (
			<section aria-label="A/B results" style={{ background: "#fff", border: "1px solid var(--rule)", borderRadius: 3, padding: 24, maxWidth: 960 }}>
				<h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>A/B results</h2>
				<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
					No comparison has been run yet. Run <code>npx tsx scripts/ab.ts --url &lt;worker url&gt;</code> to make one.
				</p>
			</section>
		);
	}
	const races = results.premise.races;
	const rate = Math.round(results.premise.falsePositiveRate * 100);
	return (
		<section aria-label="A/B results" style={{ background: "#fff", border: "1px solid var(--rule)", borderRadius: 3, padding: 24, maxWidth: 960 }}>
			<h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>A/B results</h2>
			<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
				The same {results.baseline.tasksDispatched} tasks and {results.n} scripted workload Intents (seed {results.seed}), run twice on real Artifacts on {results.date}: once landing on a text rebase and a typecheck, once through Premise.
			</p>
			<p style={{ margin: "16px 0 0", fontSize: 20, lineHeight: 1.3, fontWeight: 600, maxWidth: 760 }}>{results.headline}</p>
			<p style={{ margin: "16px 0 0", fontSize: 13, maxWidth: 760, borderLeft: "4px solid var(--amber)", paddingLeft: 12 }}>
				<strong>What it cost: a {rate}% false-positive rate.</strong> {races.rebaseWon} of the {races.started} Intents that Premise turned stale would have landed on a plain rebase anyway, so for them the broken premise cost time and changed
				nothing. Premises are the early warning. The gate is the guarantee.
			</p>
			<table style={{ marginTop: 24, fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
				<thead>
					<tr style={{ textAlign: "left" }}>
						<th scope="col" style={{ padding: "0 16px 8px 0", fontWeight: 600 }}>
							Measure
						</th>
						<th scope="col" style={{ padding: "0 16px 8px 0", fontWeight: 600, width: 216 }}>
							Baseline
						</th>
						<th scope="col" style={{ padding: "0 16px 8px 0", fontWeight: 600, width: 216 }}>
							Premise
						</th>
					</tr>
				</thead>
				<tbody>
					{results.table.map((row) => (
						<tr key={row.metric}>
							<th scope="row" style={{ ...cell, textAlign: "left", fontWeight: row.metric === FALSE_POSITIVES ? 600 : 400 }}>
								{row.metric}
								{row.note ? <span style={{ display: "block", fontSize: 12, color: "var(--ink-soft)", fontWeight: 400, marginTop: 2, maxWidth: 520 }}>{row.note}</span> : null}
							</th>
							<td className="callsign" style={{ ...cell, fontSize: 20, lineHeight: 1 }}>
								{row.baseline}
							</td>
							<td className="callsign" style={{ ...cell, fontSize: 20, lineHeight: 1 }}>
								{row.premise}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
