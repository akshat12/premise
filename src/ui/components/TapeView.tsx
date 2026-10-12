import { ArrowsClockwise, Bell, CheckCircle, Eye, PencilSimple, XCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IntentId } from "../../shared/types";
import { jobLine, type StoryStep } from "../lib/story";
import { clock, type Tape, type TapeBreak, type TapeRow, type TapeSegment } from "../lib/tape";
import { type Lanes, type Layout, STATUS_LOOK } from "../lib/view";
import { BAND, StatusMark } from "./Strip";

interface TapeViewProps {
	tape: Tape;
	/** The scripted workload's counts, for its row's label. */
	workload: Lanes["workload"];
	layout: Layout;
	selected: IntentId | null;
	onSelect: (id: IntentId) => void;
	/** Following the live log: the playhead says "now" instead of a time. */
	live: boolean;
	/** A replay that has finished, or a still: nothing is "not yet", so the future is not shaded. */
	ended: boolean;
	/** In a replay: how long the recording is, and how to move it. With these the time axis is a slider. */
	total?: number;
	/** `nudge` says the move is a step in that direction, and must not stand still when no event falls inside it. */
	onSeek?: (ms: number, nudge?: -1 | 1) => void;
	/** The story's step on screen: the rows it is about stay lit, and a row whose tests all passed shows what was checked. */
	step?: StoryStep;
	/** A few words for the end of a row ("not affected"). */
	notes?: Readonly<Record<IntentId, string>>;
}

/**
 * How much room a row gets. A handful of agents get tall rows that say what each is doing and
 * what it relies on; up to sixteen get a line for the job; more than that get the name alone.
 */
export type Density = "roomy" | "medium" | "compact";
export const densityFor = (rows: number): Density => (rows <= 6 ? "roomy" : rows <= 16 ? "medium" : "compact");

/** The width of an element in pixels, kept up to date. Words on the tape are drawn only where they fit. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T | null>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (element === null) {
			return;
		}
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}

/** A break this recent is drawn in (350ms); an older one is simply there. */
const FRESH_MS = 1500;

/** Roughly how wide an uppercase mono label is, with its padding. Close enough to decide whether to draw it. */
const wide = (label: string, icon = false) => label.length * 7.4 + 18 + (icon ? 18 : 0);

/** One reading in the gate's readout: a label over what was found. */
function Reading({ label, value, ok }: { label: string; value: string; ok: boolean }) {
	return (
		<span className="tape-check" data-ok={ok}>
			<span className="label">{label}</span>
			<span className="figure">{value}</span>
		</span>
	);
}

interface MarksProps {
	row: TapeRow;
	tape: Tape;
	/** The track's width in pixels. */
	width: number;
	/** Marks only, no words: the phone's 12px track. */
	bare: boolean;
	/** A few words after the row's end. */
	note?: string;
	/** What the gate ran on this row's rebased work, when every test passed and only the premise failed. */
	checks?: StoryStep["checks"];
}

function Segment({ segment, tape, width, bare }: { segment: TapeSegment; tape: Tape; width: number; bare: boolean }) {
	const pixels = ((segment.to - segment.from) / tape.span) * width;
	const style = { left: `${(segment.from / tape.span) * 100}%`, width: `${((segment.to - segment.from) / tape.span) * 100}%` };
	const icon = segment.kind === "rederive" || segment.kind === "person";
	const words = !bare && segment.label !== "" && pixels >= wide(segment.label, icon);
	if (segment.kind === "stale") {
		// The Intent has stopped: a red line from where it stopped to where its re-derive begins.
		return (
			<span className="tape-stale" data-fresh={tape.now - segment.from < FRESH_MS} style={style} title={segment.tip}>
				{words ? <span className="tape-stale-label">{segment.label}</span> : null}
			</span>
		);
	}
	return (
		<span className="tape-bar" data-kind={segment.kind} data-open={segment.open} data-rebased={segment.rebased} style={style} title={segment.tip}>
			{words ? (
				<>
					{segment.kind === "rederive" && !segment.rebased ? <ArrowsClockwise size={12} weight="bold" /> : null}
					{segment.kind === "person" ? <Bell size={12} weight="fill" /> : null}
					<span>{segment.label}</span>
				</>
			) : null}
		</span>
	);
}

/** One Intent's marks along the time axis. Decorative: the row's button says the same in words. */
function Marks({ row, tape, width, bare, note, checks }: MarksProps) {
	const pct = (ms: number) => `${(ms / tape.span) * 100}%`;
	const end = row.end;
	const room = end === undefined ? 0 : ((tape.span - end.at) / tape.span) * width;
	const hit = row.hits[0];
	// The callout hangs under the break. Near the right edge it is anchored to the right instead, so it stays on the tape.
	const calloutRight = hit !== undefined && (hit / tape.span) * width > width - 600;
	return (
		<span className="tape-track" data-bare={bare} aria-hidden="true">
			{row.segments.map((segment) => (
				<Segment key={`${segment.kind}-${segment.from}`} segment={segment} tape={tape} width={width} bare={bare} />
			))}
			{row.hits.map((hit) => (
				// The line draws itself in only when the break has just happened, not every time the tape is opened.
				<span key={hit} data-fresh={tape.now - hit < FRESH_MS}>
					<span className="tape-hit" style={{ left: pct(hit) }} />
					<span className="tape-dot" style={{ left: pct(hit) }} />
				</span>
			))}
			{row.asks.map((ask) => (
				<span key={ask.at} className="tape-ask" data-open={ask.open} style={{ left: pct(ask.at) }} title={ask.tip}>
					<Bell size={bare ? 10 : 12} weight="fill" />
				</span>
			))}
			{end ? (
				<span className="tape-cap" data-kind={end.kind} style={{ left: pct(end.at) }} title={end.kind === "landed" ? `Landed at ${clock(end.at)}${end.sha ? ` (${end.sha.slice(0, 7)})` : ""}` : `Failed at ${clock(end.at)}`}>
					{end.kind === "landed" ? <CheckCircle size={bare ? 14 : 18} weight="fill" /> : <XCircle size={bare ? 14 : 18} weight="bold" />}
					{end.kind === "failed" && !bare && room >= 64 ? <span className="tape-cap-word">failed</span> : null}
					{end.kind === "landed" && note !== undefined && !bare && room >= wide(note) + 24 ? <span className="tape-note">{note}</span> : null}
				</span>
			) : null}
			{checks !== undefined && hit !== undefined && !bare ? (
				<span className="tape-checks" style={calloutRight ? { right: 8 } : { left: `calc(${pct(hit)} + 10px)` }}>
					<span className="tape-readings">
						<Reading label="Its tests" value={`${checks.own} / ${checks.own}`} ok />
						{checks.reference > 0 ? <Reading label="Reference checks" value={`${checks.reference} / ${checks.reference}`} ok /> : null}
						{checks.suite > 0 ? <Reading label="Existing tests" value={`${checks.suite} / ${checks.suite}`} ok /> : null}
						<Reading label="Its premise" value="Failed" ok={false} />
					</span>
					{checks.premise ? <span className="tape-check-premise">Its premise was: “{checks.premise}”</span> : null}
				</span>
			) : null}
		</span>
	);
}

/** What each mark means: a mark and a word, never a colour alone. */
function Key({ cutMs }: { cutMs: number }) {
	return (
		<ul className="tape-key" aria-label="Key">
			<li>
				<span className="tape-bar tape-swatch" data-kind="work" />
				working
			</li>
			<li>
				<span className="tape-bar tape-swatch" data-kind="gate" />
				at the gate
			</li>
			<li>
				<span className="tape-swatch-break">
					<span className="tape-dot" />
				</span>
				premise broke
			</li>
			<li>
				<span className="tape-bar tape-swatch" data-kind="rederive" />
				re-deriving
			</li>
			<li>
				<span className="tape-bar tape-swatch" data-kind="wait" />
				waiting
			</li>
			<li>
				<span className="tape-bar tape-swatch" data-kind="person" />
				needs you
			</li>
			<li>
				<CheckCircle size={16} weight="fill" color="var(--holds)" aria-hidden="true" />
				landed
			</li>
			{cutMs > 0 ? (
				<li>
					<span className="tape-cut tape-swatch-cut" />
					idle time cut from the recording ({Math.round(cutMs / 1000)} s in all)
				</li>
			) : null}
		</ul>
	);
}

/**
 * The tape: time runs left to right, one row for each agent's Intent, with trunk along the top.
 * A landing that broke a premise is a red line through the rows it stopped, and only those.
 */
export function TapeView({ tape, workload, layout, selected, onSelect, live, ended, total, onSeek, step, notes }: TapeViewProps) {
	const phone = layout === "phone";
	const density: Density = phone ? "compact" : densityFor(tape.rows.length);
	const focus = step?.focus ?? [];
	const [axisRef, width] = useWidth<HTMLDivElement>();
	// The break the pointer or the keyboard is on, and the one that was chosen to stay explained.
	const [hot, setHot] = useState<number | null>(null);
	const [chosen, setChosen] = useState<number | null>(null);
	const pct = (ms: number) => `${(ms / tape.span) * 100}%`;
	const px = (ms: number) => (ms / tape.span) * width;

	const shown: TapeBreak | undefined = tape.breaks.find((line) => line.n === (hot ?? chosen));
	// A flag under the pointer says which rows it stopped. Otherwise the story's step says which rows it is about.
	const dimmed = (id: IntentId) => (shown !== undefined ? !shown.rows.includes(id) : focus.length > 0 && !focus.includes(id));
	const needing = tape.rows.filter((row) => row.status === "escalated");
	const asked = tape.rows.filter((row) => row.status !== "escalated" && row.asks.some((ask) => ask.open));
	const latest = tape.breaks.at(-1);
	const landings = tape.landings.length;

	const seekable = onSeek !== undefined && total !== undefined;
	const slider = seekable
		? {
				role: "slider" as const,
				tabIndex: 0,
				"aria-label": "Replay position",
				"aria-valuemin": 0,
				"aria-valuemax": Math.round(total / 1000),
				"aria-valuenow": Math.round(tape.now / 1000),
				"aria-valuetext": `${clock(tape.now)} of ${clock(total)}`,
				onKeyDown: (event: React.KeyboardEvent) => {
					if (event.key === "Home" || event.key === "End") {
						event.preventDefault();
						onSeek(event.key === "Home" ? 0 : total);
						return;
					}
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
						return;
					}
					// These arrows move the replay by seconds. They do not go on to the page's "next key moment" key.
					event.preventDefault();
					event.stopPropagation();
					const direction = event.key === "ArrowLeft" ? -1 : 1;
					onSeek(Math.min(total, Math.max(0, tape.now + (event.shiftKey ? 10_000 : 1000) * direction)), direction);
				},
				onClick: (event: React.MouseEvent<HTMLDivElement>) => {
					const box = event.currentTarget.getBoundingClientRect();
					onSeek(Math.min(total, Math.max(0, ((event.clientX - box.left) / box.width) * tape.span)));
				},
			}
		: {};

	// Which flags have room for their words, worked out in pixels: one that would run into the flag before it
	// (or off either edge) is a numbered marker instead.
	const fitted = useMemo(() => {
		let taken = -Infinity;
		return tape.breaks.map((line, index) => {
			const x = (line.at / tape.span) * width;
			const size = Math.min(380, wide(line.flag) + 8);
			// A flag whose words would run under the next break's marker is written to the left of its line, where there is room.
			const next = tape.breaks[index + 1];
			const crowded = next !== undefined && (next.at / tape.span) * width - 14 < x + size;
			const flip = x + size > width || (crowded && x - size >= Math.max(0, taken + 8));
			const [from, to] = flip ? [x - size, x] : [x, x + size];
			const written = !phone && width > 0 && from >= Math.max(0, taken + 8);
			taken = Math.max(taken, written ? to : x + 12);
			return { written, flip: written && flip };
		});
	}, [tape.breaks, tape.span, width, phone]);

	const flags = tape.breaks.map((line, index) => {
		const { written, flip } = fitted[index] ?? { written: false, flip: false };
		return (
			<button
				key={line.n}
				type="button"
				className="tape-flag"
				data-written={written}
				data-flip={flip}
				style={flip ? { right: `${(1 - line.at / tape.span) * 100}%` } : { left: pct(line.at) }}
				aria-pressed={chosen === line.n}
				aria-label={line.sentence}
				title={written ? undefined : line.flag}
				onMouseEnter={() => setHot(line.n)}
				onMouseLeave={() => setHot(null)}
				onFocus={() => setHot(line.n)}
				onBlur={() => setHot(null)}
				onClick={() => setChosen((current) => (current === line.n ? null : line.n))}
			>
				{written ? line.flag : line.n}
			</button>
		);
	});

	const trunk = (
		<div className="tape-trunk" aria-hidden="true">
			<span className="tape-rail" style={{ width: pct(tape.now) }} />
			{tape.landings.map((landing) => (
				<span key={landing.id} className="tape-landing" data-agent={landing.agent} style={{ left: pct(landing.at) }} title={landing.tip} />
			))}
			{tape.cuts.map((cut) => (
				<span key={cut.at} className="tape-cut" style={{ left: pct(cut.at) }} title={cut.label} />
			))}
			{tape.breaks.map((line) => (
				<span key={line.n}>
					<span className="tape-stem" style={{ left: pct(line.at) }} />
					<span className="tape-diamond" style={{ left: pct(line.at) }} />
				</span>
			))}
		</div>
	);

	const under = (
		<div className="tape-under" aria-hidden="true">
			{ended ? null : <span className="tape-future" style={{ left: pct(tape.now) }} />}
			{tape.ticks.slice(1).map((tick) => (
				<span key={tick} className="tape-gridline" style={{ left: pct(tick) }} />
			))}
			{tape.breaks.map((line) => (
				<span key={line.n} className="tape-break" style={{ left: pct(line.at) }} />
			))}
		</div>
	);
	const over = (
		<div className="tape-over" aria-hidden="true">
			<span className="tape-now" style={{ left: pct(tape.now) }} />
		</div>
	);

	const densityStrip = tape.workload ? (
		<span className="tape-track tape-density" aria-hidden="true">
			{tape.workload.landed.map((count, index) => {
				const from = index * (tape.workload?.bucketMs ?? 0);
				const stale = tape.workload?.stale[index] ?? false;
				if (count === 0 && !stale) {
					return null;
				}
				return (
					<span key={from} className="tape-density-slot" style={{ left: pct(from), width: pct(tape.workload?.bucketMs ?? 0) }} title={`${clock(from)}: ${count} landed${stale ? ", some were stopped" : ""}`}>
						{count > 0 ? <span className="tape-density-bar" style={{ height: `${Math.max(12, (count / (tape.workload?.peak ?? 1)) * 100)}%` }} /> : null}
						{stale ? <span className="tape-density-stale" /> : null}
					</span>
				);
			})}
		</span>
	) : null;
	const allCounts = workload ? [`${workload.landed} landed`, workload.moving > 0 ? `${workload.moving} in flight` : null, workload.stale > 0 ? `${workload.stale} stopped` : null, workload.failed > 0 ? `${workload.failed} gave up` : null].filter((part): part is string => part !== null) : [];
	// The narrow label column has room for two of them; the rest are in its tooltip.
	const workloadCounts = (layout === "medium" ? allCounts.slice(0, 2) : allCounts).join(" · ");
	const cutMs = tape.cuts.reduce((sum, cut) => sum + cut.ms, 0);

	// With the drawer open the selected row can be under it: bring it into view.
	const sectionRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (selected === null) {
			return;
		}
		const frame = requestAnimationFrame(() => sectionRef.current?.querySelector('.tape-row[data-selected="true"]')?.scrollIntoView({ block: "nearest" }));
		return () => cancelAnimationFrame(frame);
	}, [selected]);

	const rows = (
		<ol className="tape-rows" aria-label="Intents over time">
			{tape.rows.map((row) => {
				const rowChecks = step?.checks?.intentId === row.id ? step.checks : undefined;
				const inFocus = focus.includes(row.id);
				const status = <StatusMark status={row.status} size={12} />;
				return (
					<li key={row.id} className="tape-row" data-selected={selected === row.id} data-dimmed={dimmed(row.id)} data-focus={inFocus} data-callout={rowChecks !== undefined && density === "roomy"}>
						<button type="button" className="tape-label" data-node-id={`strip-${row.id}`} style={{ ["--band" as string]: BAND[STATUS_LOOK[row.status].band] }} aria-pressed={selected === row.id} aria-label={row.summary} onClick={() => onSelect(row.id)}>
							<span className="tape-band" aria-hidden="true" />
							<span className="tape-name">
								<span className="callsign tape-callsign">{row.callsign}</span>
								{row.races > 0 ? (
									<span className="stamp callsign tape-stamp" title={`Its work was redone ${row.races === 1 ? "once" : `${row.races} times`} (a re-derive)`}>
										R{row.races}
									</span>
								) : null}
								{row.asks.some((ask) => ask.open) && row.status !== "escalated" ? <Bell size={14} weight="fill" color="var(--redpen)" aria-hidden="true" /> : null}
								{density === "compact" ? null : <span className="tape-status tape-status-inline">{status}</span>}
							</span>
							{density === "compact" ? (
								<span className="tape-status">{status}</span>
							) : (
								<span className="tape-job" title={row.title}>
									{jobLine(row.title, 96)}
								</span>
							)}
							{/* What it changes (pencil) and what it relies on (eye): the two lists every Intent has. */}
							{density === "roomy" && row.changes.length > 0 ? (
								<span className="tape-relies" data-kind="changes" title={`Changes ${row.changes.join(", ")}`}>
									<PencilSimple size={14} aria-hidden="true" />
									<span>
										<span className="tape-relies-label">Changes</span>
										<span className="tape-relies-what symbol">{row.changes.slice(0, 2).join(", ")}</span>
										{row.changes.length > 2 ? ` and ${row.changes.length - 2} more` : ""}
									</span>
								</span>
							) : null}
							{(density === "roomy" || (density === "medium" && inFocus)) && row.relies !== null ? (
								<span className="tape-relies" data-broken={row.relies.broken} title={`Relies on: ${row.relies.text}`}>
									<Eye size={14} aria-hidden="true" />
									<span>
										<span className="tape-relies-label">{row.relies.broken ? "Relied on" : "Relies on"}</span>
										<span className="tape-relies-what">{row.relies.text}</span>
									</span>
								</span>
							) : null}
							{phone ? <Marks row={row} tape={tape} width={width} bare /> : null}
						</button>
						{phone ? null : (
							// Clicking anywhere on the row's marks selects it, as its button does. The button is the keyboard's way in.
							<span className="tape-trackwrap" onClick={() => onSelect(row.id)}>
								<Marks row={row} tape={tape} width={width} bare={false} {...(notes?.[row.id] === undefined ? {} : { note: notes[row.id] as string })} {...(rowChecks !== undefined && density === "roomy" ? { checks: rowChecks } : {})} />
							</span>
						)}
					</li>
				);
			})}
		</ol>
	);

	return (
		<section ref={sectionRef} className="tape bracketed" data-layout={layout} data-density={density} data-seekable={seekable} aria-label="The agents over time">
			{/* Said aloud when it changes: a landing that broke premises, and any Intent that is waiting on a person. */}
			<p className="tape-sr" aria-live="polite">
				{[latest?.sentence, ...needing.map((row) => `${row.callsign} needs you.`), ...asked.map((row) => `${row.callsign}: ${row.asks.at(-1)?.tip ?? ""}`)].filter(Boolean).join(" ")}
			</p>

			{phone && tape.breaks.length > 0 ? (
				<ol className="tape-breaklist" aria-label="Landings that broke premises">
					{tape.breaks.map((line) => (
						<li key={line.n}>
							<span className="tape-flag" data-written="false" aria-hidden="true">
								{line.n}
							</span>
							<span>
								{clock(line.at)} · {line.flag} · {line.rows.length} stopped
							</span>
						</li>
					))}
				</ol>
			) : null}

			<div className="tape-head">
				<div className="tape-headrow">
					<div className="tape-headcell tape-soft">{phone ? null : "Time"}</div>
					<div className="tape-axis">
						<div className="tape-ticks" ref={axisRef} {...slider}>
							{(phone ? [0, tape.span / 2] : tape.ticks).map((tick) => (
								<span key={tick} className="tape-tick" style={{ left: pct(tick) }}>
									{clock(tick)}
								</span>
							))}
							<span className="tape-now-pill" data-flip={px(tape.now) > width - 30} style={{ left: pct(tape.now) }}>
								{live ? "now" : clock(tape.now)}
							</span>
						</div>
						<div className="tape-flags">{flags}</div>
					</div>
				</div>
				{shown ? (
					<p className="tape-sentence" role="status">
						{shown.sentence}
					</p>
				) : null}
				<div className="tape-headrow">
					<div className="tape-headcell">
						<b>Trunk</b>
						<span className="tape-soft">
							{landings} {landings === 1 ? "landing" : "landings"}
						</span>
					</div>
					{trunk}
				</div>
			</div>

			<div className="tape-body">
				{under}
				{rows}
				{tape.workload && workload ? (
					<div className="tape-row tape-workrow">
						<div className="tape-label">
							<span className="tape-band" aria-hidden="true" />
							<span className="tape-name">
								<span className="callsign tape-callsign">WORKLOAD {workload.total}</span>
								{phone ? null : <span className="tape-soft">scripted</span>}
							</span>
							<span className="tape-soft" title={`Scripted, not a model. ${allCounts.join(", ")}`}>
								{phone ? `scripted, no model · ${workloadCounts}` : workloadCounts}
							</span>
							{phone ? densityStrip : null}
						</div>
						{phone ? null : densityStrip}
					</div>
				) : null}
				{over}
			</div>

			<footer className="tape-foot">
				<Key cutMs={cutMs} />
			</footer>
		</section>
	);
}
