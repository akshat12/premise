import { useEffect, useState } from "react";
import type { RecentRuns as Runs } from "../../shared/runs";
import { runRows, runsHeadline } from "../lib/runs";

/** How often the list is asked for while the Results tab is open. A run takes minutes, so this is plenty. */
const REFRESH_MS = 15_000;
/** How many rows are shown before "Show all". */
const SHOWN = 5;

interface RecentRunsProps {
	/** Go to the Live tab, where the run on the board is. */
	onWatch: () => void;
}

/**
 * Every run of the live board, one line each: the run on it now, and the ones before, which the
 * Worker keeps when the board is cleared. Nothing is chosen or left out, so a run that went wrong
 * is in the list with the rest.
 */
export function RecentRuns({ onWatch }: RecentRunsProps) {
	const [runs, setRuns] = useState<Runs | null>(null);
	const [unreachable, setUnreachable] = useState(false);
	const [all, setAll] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		let current = true;
		const load = () => {
			fetch("/api/runs", { cache: "no-store" })
				.then(async (response) => (response.ok ? ((await response.json()) as Runs) : null))
				.then((body) => {
					if (!current) {
						return;
					}
					if (body !== null && Array.isArray(body.past)) {
						setRuns(body);
						setUnreachable(false);
						setNow(Date.now());
					} else {
						setUnreachable(true);
					}
				})
				// A page served as plain files has no Worker to ask.
				.catch(() => current && setUnreachable(true));
		};
		load();
		const timer = setInterval(load, REFRESH_MS);
		return () => {
			current = false;
			clearInterval(timer);
		};
	}, []);

	const rows = runs === null ? [] : runRows(runs, now);
	const shown = all ? rows : rows.slice(0, SHOWN);
	return (
		<section aria-label="Live runs" className="plane bracketed">
			<h2 className="label plane-kicker">Live runs</h2>
			<p className="plane-title">{runs === null ? (unreachable ? "The list of live runs is not available from here." : "Reading the list of live runs…") : runsHeadline(runs)}</p>
			<p className="plane-lede">
				{runs === null && unreachable
					? "It is kept by the deployed Worker, and this page cannot reach one."
					: "Every run of the live board, whoever started it, is kept as one line when the next run clears the board. None is left out, so a run that went wrong would be listed with the rest. The agents in them are scripted."}{" "}
				{runs !== null ? (
					<button type="button" className="plane-link runs-watch" onClick={onWatch}>
						{runs.current === null ? "Start one on the Live tab" : "See it on the Live tab"}
					</button>
				) : null}
			</p>
			{rows.length > 0 ? (
				<div className="runs-scroll">
					<table className="runs">
						<thead>
							<tr>
								<th scope="col" className="label">
									Started
								</th>
								<th scope="col" className="label">
									By
								</th>
								<th scope="col" className="label runs-num">
									Took
								</th>
								<th scope="col" className="label runs-num">
									Agents landed
								</th>
								<th scope="col" className="label runs-num">
									Workload landed
								</th>
								<th scope="col" className="label runs-num">
									Premises broken
								</th>
								<th scope="col" className="label runs-num">
									Re-derived
								</th>
								<th scope="col" className="label runs-num">
									Problems on trunk
								</th>
							</tr>
						</thead>
						<tbody>
							{shown.map((row) => (
								<tr key={row.key} data-current={row.current}>
									<th scope="row">
										{row.when}
										{row.note ? <span className="label runs-note">{row.note}</span> : null}
									</th>
									<td>{row.by}</td>
									<td className="runs-num">{row.took}</td>
									<td className="runs-num">{row.agents}</td>
									<td className="runs-num">{row.workload}</td>
									<td className="runs-num">{row.premisesBroken}</td>
									<td className="runs-num">{row.rederived}</td>
									<td className="runs-num runs-problems" data-tone={row.problems > 0 ? "accent" : "good"}>
										{row.problems}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{rows.length > SHOWN ? (
				<button type="button" className="label runs-more" onClick={() => setAll((value) => !value)} aria-expanded={all}>
					{all ? "Show fewer" : `Show all ${rows.length}`}
				</button>
			) : null}
		</section>
	);
}
