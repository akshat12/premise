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
export function RunFigures({ figures }: { figures: RunFigureValues }) {
	const { agents, workload, premisesBroken, rederived, asked, landed, problems } = figures;
	const intents = agents + workload;
	return (
		<section className="figures" aria-label="The run in numbers">
			<Cell label="Agents" value={agents} sub={workload > 0 ? `and ${workload} scripted intents` : "each on its own fork"} />
			<Cell label="Premises broken" value={premisesBroken} sub="work stopped at once" {...(premisesBroken > 0 ? { tone: "accent" as const } : {})} />
			<Cell label="Re-derived" value={rederived} sub={asked === 0 ? "with nobody involved" : `a person was asked ${asked === 1 ? "once" : `${asked} times`}`} />
			<Cell label="Landed" value={landed} sub={`of ${intents}`} {...(intents > 0 && landed === intents ? { tone: "good" as const } : {})} />
			<Cell label="Problems on trunk" value={problems} sub={problems === 0 ? "nothing got through" : "reached trunk broken"} {...(problems > 0 ? { tone: "accent" as const } : {})} />
		</section>
	);
}
