import { useCallback, useEffect, useState } from "react";
import type { RecentRuns as Runs } from "../../shared/runs";
import { deleteRun, explain } from "../lib/api";
import { allScripted, type RunRow, runRows, runsHeadline } from "../lib/runs";
import { PastRunPanel } from "./PastRunPanel";

/** How often the list is asked for while the Results tab is open. A run takes minutes, so this is plenty. */
const REFRESH_MS = 15_000;
/** How many rows are shown before "Show all". */
const SHOWN = 5;

interface RecentRunsProps {
	/** Go to the Live tab, where the run on the board is. */
	onWatch: () => void;
	/** The owner's tools are on (see ADMIN in App.tsx): each past run can be removed from the list. */
	owner: boolean;
	/** The admin token, or "" when it has not been typed in yet. */
	token: string;
	/** Asks for the admin token. */
	onNeedToken: () => void;
}

/**
 * Every run of the live board, one line each: the run on it now, and the ones before, which the
 * Worker keeps when the board is cleared. The page leaves none out, so a run that went wrong is in
 * the list with the rest. The owner can remove a run (it asks twice), and the page says so.
 */
export function RecentRuns({ onWatch, owner, token, onNeedToken }: RecentRunsProps) {
	const [runs, setRuns] = useState<Runs | null>(null);
	const [unreachable, setUnreachable] = useState(false);
	const [all, setAll] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	// The past run open beside the list, if any.
	const [open, setOpen] = useState<RunRow | null>(null);
	// The owner's Delete: the run asked about (it is asked twice), the one being removed, and what came of it.
	const [asking, setAsking] = useState<number | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const [said, setSaid] = useState<string | null>(null);
	// The runs removed here. A list read a moment ago, or answered from a cache, may still have them.
	const [removed, setRemoved] = useState<readonly number[]>([]);

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

	const remove = useCallback(
		(row: RunRow) => {
			if (token === "") {
				setAsking(null);
				onNeedToken();
				return;
			}
			setRemoving(row.id);
			setSaid(null);
			deleteRun(row.id, token).then(
				() => {
					setRemoved((ids) => [...ids, row.id]);
					setOpen((shown) => (shown?.id === row.id ? null : shown));
					setSaid(`Removed the run from ${row.when}.`);
				},
				(error: unknown) => setSaid(explain(error)),
			).finally(() => {
				setRemoving(null);
				setAsking(null);
			});
		},
		[token, onNeedToken],
	);

	const listed = runs === null ? null : { ...runs, past: runs.past.filter((run) => !removed.includes(run.id)) };
	const rows = listed === null ? [] : runRows(listed, now);
	const shown = all ? rows : rows.slice(0, SHOWN);
	return (
		<section aria-label="Live runs" className="plane bracketed">
			<h2 className="label plane-kicker">Live runs</h2>
			<p className="plane-title">{runs === null ? (unreachable ? "The list of live runs is not available from here." : "Reading the list of live runs…") : runsHeadline(listed ?? runs)}</p>
			<p className="plane-lede">
				{runs === null && unreachable
					? "It is kept by the deployed Worker, and this page cannot reach one."
					: `Every run of the live board, whoever started it, is kept as one line when the next run clears the board. The page leaves none out, so a run that went wrong would be listed with the rest; the owner can remove a run.${runs === null || allScripted(runs) ? " The agents in them are scripted." : " The agents are scripted unless a row says live model."}`}{" "}
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
								<th scope="col" className="label runs-num">
									<span className="tape-sr">{owner ? "Open it, or delete it" : "Open it"}</span>
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
									<td className="runs-num">
										{row.replay !== null ? (
											// A link, so it can be opened in a tab of its own as the story; a plain click opens it here, at its end.
											<a
												className="plane-link"
												href={row.replay}
												onClick={(event) => {
													if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
														return;
													}
													event.preventDefault();
													setOpen(row);
												}}
											>
												Open
											</a>
										) : null}
										{owner && !row.current ? (
											asking === row.id ? (
												<span className="runs-delete-ask">
													Delete it for good?
													<button type="button" className="runs-delete" disabled={removing === row.id} onClick={() => remove(row)}>
														{removing === row.id ? "Deleting…" : "Yes, delete"}
													</button>
													<button type="button" className="runs-keep" disabled={removing === row.id} onClick={() => setAsking(null)}>
														Keep
													</button>
												</span>
											) : (
												<button type="button" className="runs-delete" aria-label={`Delete the run from ${row.when}`} onClick={() => setAsking(row.id)}>
													Delete
												</button>
											)
										) : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			{said !== null ? (
				<p role="status" className="runs-said">
					{said}
				</p>
			) : null}
			{rows.length > SHOWN ? (
				<button type="button" className="label runs-more" onClick={() => setAll((value) => !value)} aria-expanded={all}>
					{all ? "Show fewer" : `Show all ${rows.length}`}
				</button>
			) : null}
			{open !== null ? <PastRunPanel run={open} onClose={() => setOpen(null)} /> : null}
		</section>
	);
}
