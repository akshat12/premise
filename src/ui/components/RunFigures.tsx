import type { RunFigureValues } from "../lib/figures";
import { RollingNumber } from "./Counter";

function Cell({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: "accent" | "good" }) {
	return (
		<div className="figures-cell" data-tone={tone} aria-label={`${label}: ${value}. ${sub}`}>
			<span className="label">{label}</span>
			<span className="figure">
				<RollingNumber value={value} />
			</span>
			<span className="label figures-sub">{sub}</span>
		</div>
	);
}

/**
 * The run in five numbers, counted from the same log the tape is drawn from, so they move as the
 * story is stepped through. The last one is the point: what reached trunk broken.
 */
export function RunFigures({ figures, ended }: { figures: RunFigureValues; ended: boolean }) {
	const { agents, workload, premisesBroken, rederived, rebased, asked, landed, problems } = figures;
	const intents = agents + workload;
	const redone = asked > 0 ? `a person was asked ${asked === 1 ? "once" : `${asked} times`}` : rebased > 0 ? `${rebased} more only needed a rebase` : "with nobody involved";
	return (
		<section className="figures" aria-label="The run in numbers">
			<Cell label="Agents" value={agents} sub={workload > 0 ? `and ${workload} scripted ${workload === 1 ? "Intent" : "Intents"}` : "each on its own fork"} />
			<Cell label="Premises broken" value={premisesBroken} sub="work stopped at once" {...(premisesBroken > 0 ? { tone: "accent" as const } : {})} />
			<Cell label="Re-derived" value={rederived} sub={redone} />
			<Cell label="Landed" value={landed} sub={`of ${intents}`} {...(intents > 0 && landed === intents ? { tone: "good" as const } : {})} />
			{/* "Nothing got through" is a verdict on the whole run, so it waits for the run to be over. */}
			<Cell label="Problems on trunk" value={problems} sub={problems > 0 ? "reached trunk broken" : ended ? "nothing got through" : "none so far"} {...(problems > 0 ? { tone: "accent" as const } : {})} />
		</section>
	);
}
