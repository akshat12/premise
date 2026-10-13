import { useEffect, useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { IntentId } from "../../shared/types";
import { explain } from "../lib/api";
import { captionAt } from "../lib/demo";
import { fetchPastRun } from "../lib/pastRun";
import { reduceAll } from "../lib/reduce";
import type { RunRow } from "../lib/runs";
import { storyFor } from "../lib/story";
import { buildTape, positionAt } from "../lib/tape";
import { useIntentDiff } from "../lib/useIntentDiff";
import { callsign, lanesOf, layoutFor, OUTSIDE } from "../lib/view";
import { Drawer } from "./Drawer";
import { TapeView } from "./TapeView";

interface PastRunPanelProps {
	/** The run's line in the table: its number, and the figures already worked out for it. */
	run: RunRow;
	onClose: () => void;
	/** The owner's: removes this run from the record for good. It rejects with what went wrong. Absent for a visitor. */
	onDelete?: () => Promise<void>;
}

/**
 * A past run of the live board, opened beside the list it was picked from. It opens on the run's
 * last moment, every lane already drawn, so there is nothing to play through; the time axis can be
 * dragged back to any earlier moment. A row opens the same details panel as on the Demo tab, with
 * what that Intent changed as it landed on the run's trunk.
 */
export function PastRunPanel({ run, onClose, onDelete }: PastRunPanelProps) {
	const [events, setEvents] = useState<PremiseEvent[] | null>(null);
	const [failed, setFailed] = useState(false);
	// How many of the run's events are on screen. null is "all of them": where it opens.
	const [position, setPosition] = useState<number | null>(null);
	const [selected, setSelected] = useState<IntentId | null>(null);
	// The owner's Delete asks first: whether the question is up, whether it is being done, and what went wrong.
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [refused, setRefused] = useState<string | null>(null);
	const keep = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		if (confirming) {
			keep.current?.focus();
		}
	}, [confirming]);
	const doDelete = () => {
		if (onDelete === undefined) {
			return;
		}
		setDeleting(true);
		setRefused(null);
		onDelete().catch((error: unknown) => {
			// On success this panel is closed by whoever opened it; only a refusal is left to say here.
			setRefused(explain(error));
			setDeleting(false);
		});
	};
	const panel = useRef<HTMLDivElement | null>(null);
	const [width, setWidth] = useState(0);

	useEffect(() => {
		let current = true;
		setEvents(null);
		setFailed(false);
		setPosition(null);
		setSelected(null);
		setConfirming(false);
		setDeleting(false);
		setRefused(null);
		if (run.replay === null) {
			// Only its line was kept. There is nothing to read, and nothing wrong.
			setFailed(true);
			return;
		}
		fetchPastRun(run.id).then(
			(log) => current && (log.length > 0 ? setEvents(log) : setFailed(true)),
			() => current && setFailed(true),
		);
		return () => {
			current = false;
		};
	}, [run.id, run.replay]);

	useEffect(() => {
		const element = panel.current;
		if (element === null) {
			return;
		}
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		setWidth(element.clientWidth);
		panel.current?.focus();
		return () => observer.disconnect();
	}, []);

	// Esc closes the details panel first, then this one. Caught here so the page behind does not also act on it.
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "Escape") {
			return;
		}
		event.stopPropagation();
		if (confirming) {
			if (!deleting) {
				setConfirming(false);
			}
		} else if (selected !== null) {
			setSelected(null);
		} else {
			onClose();
		}
	};

	const all = events ?? [];
	const at = position ?? all.length;
	const shown = useMemo(() => all.slice(0, at), [all, at]);
	const state = useMemo(() => reduceAll(shown), [shown]);
	const story = useMemo(() => (all.length === 0 ? null : storyFor(all, (place) => captionAt(all, place))), [all]);
	const total = all.length > 0 ? (all[all.length - 1] as PremiseEvent).ts - (all[0] as PremiseEvent).ts : 0;
	const tape = useMemo(() => buildTape(shown, state.intents, total, story?.names), [shown, state.intents, total, story]);
	const lanes = useMemo(() => lanesOf(state), [state]);
	const layout = layoutFor(width === 0 ? 1100 : width);
	const selectedIntent = selected === null ? undefined : state.intents[selected];
	const diff = useIntentDiff(selectedIntent, "replay", null, run.id);
	const callsignOf = (id: IntentId) => {
		const intent = state.intents[id];
		return story?.names[id] ?? (intent ? callsign(intent) : id === OUTSIDE ? "a push to trunk" : id);
	};
	const named = (text: string) => text.replace(/\bi[0-9a-z]{8}\b/g, (id) => (state.intents[id] ? callsignOf(id) : id)).replace(/\bintent ((?:T\d+|Agent \d+) )/g, "$1");
	const ending = story?.steps.at(-1);

	return (
		<div className="past-run-layer">
			<button type="button" className="past-run-scrim" aria-label="Close the run" onClick={onClose} />
			<div ref={panel} className="past-run" role="dialog" aria-modal="true" aria-label={`The live run from ${run.when}`} tabIndex={-1} onKeyDown={onKeyDown}>
				<header className="past-run-head">
					<div className="past-run-title">
						<p className="label past-run-kicker">
							A past live run · {run.when} · started by {run.by}
						</p>
						<h2>{events === null ? (failed ? (run.replay === null ? "Only this run's line was kept, not its events." : "This run is not in the Worker's record any more.") : "Reading the run…") : (ending?.title ?? "The run, as it ended.")}</h2>
					</div>
					{run.replay !== null ? (
						<a className="past-run-story" href={`/?run=${run.id}`}>
							Play it as a story
						</a>
					) : null}
					{onDelete !== undefined ? (
						<button type="button" className="past-run-delete label" onClick={() => setConfirming(true)}>
							Delete
						</button>
					) : null}
					<button type="button" className="past-run-close label" onClick={onClose}>
						Close
					</button>
				</header>
				<dl className="past-run-figures">
					<div>
						<dt className="label">Agents landed</dt>
						<dd>{run.agents}</dd>
					</div>
					<div>
						<dt className="label">Workload landed</dt>
						<dd>{run.workload}</dd>
					</div>
					<div>
						<dt className="label">Premises broken</dt>
						<dd>{run.premisesBroken}</dd>
					</div>
					<div>
						<dt className="label">Re-derived</dt>
						<dd>{run.rederived}</dd>
					</div>
					<div>
						<dt className="label">Problems on trunk</dt>
						<dd data-tone={run.problems > 0 ? "accent" : "good"}>{run.problems}</dd>
					</div>
				</dl>
				<div className="past-run-body">
					{events !== null ? (
						<>
							<p className="past-run-hint">{at === all.length ? "This is the run at its end. Click or drag along the time axis to see any earlier moment; click a row for what that agent changed." : "An earlier moment of the run."} {at === all.length ? null : <button type="button" className="plane-link past-run-end" onClick={() => setPosition(null)}>Back to the end</button>}</p>
							<TapeView tape={tape} workload={lanes.workload} layout={layout} selected={selected} onSelect={(id) => setSelected((now) => (now === id ? null : id))} live={false} ended={at === all.length} total={total} onSeek={(ms) => setPosition(positionAt(all, ms))} notes={story?.notes ?? {}} />
						</>
					) : null}
				</div>
				{confirming ? (
					<div className="past-run-confirm-layer">
						<div className="past-run-confirm" role="alertdialog" aria-modal="true" aria-labelledby="past-run-confirm-title" aria-describedby="past-run-confirm-detail">
							<h3 id="past-run-confirm-title">Delete this run?</h3>
							<p id="past-run-confirm-detail">
								The run from {run.when} ({run.agents} agents landed) is removed from the list for good, with its events and its copy of trunk. This cannot be undone.
							</p>
							{refused !== null ? (
								<p role="alert" className="past-run-confirm-refused">
									{refused}
								</p>
							) : null}
							<div className="past-run-confirm-actions">
								<button ref={keep} type="button" className="past-run-confirm-keep" disabled={deleting} onClick={() => setConfirming(false)}>
									Keep it
								</button>
								<button type="button" className="past-run-confirm-delete" disabled={deleting} onClick={doDelete}>
									{deleting ? "Deleting…" : "Delete"}
								</button>
							</div>
						</div>
					</div>
				) : null}
				{selectedIntent ? <Drawer intent={selectedIntent} events={shown} callsignOf={callsignOf} named={named} diff={diff} changesFrom="past-run" layout={layout} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
			</div>
		</div>
	);
}
