import { ArrowsClockwise, Bell, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { IntentId } from "../../shared/types";
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
	onSeek?: (ms: number) => void;
}

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

/** Roughly how wide a 12 to 13px label is, with its padding. Close enough to decide whether to draw it. */
const wide = (label: string, icon = false) => label.length * 6.8 + 16 + (icon ? 18 : 0);

interface MarksProps {
	row: TapeRow;
	tape: Tape;
	/** The track's width in pixels. */
	width: number;
	/** Marks only, no words: the phone's 12px track. */
	bare: boolean;
}

function Segment({ segment, tape, width, bare }: { segment: TapeSegment; tape: Tape; width: number; bare: boolean }) {
	const pixels = ((segment.to - segment.from) / tape.span) * width;
	const style = { left: `${(segment.from / tape.span) * 100}%`, width: `${((segment.to - segment.from) / tape.span) * 100}%` };
	const icon = segment.kind === "rederive" || segment.kind === "person";
	const words = !bare && segment.label !== "" && pixels >= wide(segment.label, icon);
	if (segment.kind === "stale") {
		// The Intent has stopped: a red line from where it stopped to where its re-derive begins.
		return (
			<span className="tape-stale" style={style} title={segment.tip}>
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
function Marks({ row, tape, width, bare }: MarksProps) {
	const pct = (ms: number) => `${(ms / tape.span) * 100}%`;
	const end = row.end;
	const room = end === undefined ? 0 : ((tape.span - end.at) / tape.span) * width;
	return (
		<span className="tape-track" data-bare={bare} aria-hidden="true">
			{row.segments.map((segment) => (
				<Segment key={`${segment.kind}-${segment.from}`} segment={segment} tape={tape} width={width} bare={bare} />
			))}
			{row.hits.map((hit) => (
				<span key={hit}>
					<span className="tape-hit" style={{ left: pct(hit) }} />
					<span className="tape-dot" style={{ left: pct(hit) }} />
				</span>
			))}
			{end ? (
				<span className="tape-cap" data-kind={end.kind} style={{ left: pct(end.at) }} title={end.kind === "landed" ? `Landed at ${clock(end.at)}${end.sha ? ` (${end.sha.slice(0, 7)})` : ""}` : `Failed at ${clock(end.at)}`}>
					{end.kind === "landed" ? <CheckCircle size={bare ? 14 : 18} weight="fill" /> : <XCircle size={bare ? 14 : 18} weight="bold" />}
					{end.kind === "failed" && !bare && room >= 64 ? <span className="tape-cap-word">failed</span> : null}
				</span>
			) : null}
		</span>
	);
}

/** What each mark means: a mark and a word, never a colour alone. */
function Key() {
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
		</ul>
	);
}

/**
 * The tape: time runs left to right, one row for each agent's Intent, with trunk along the top.
 * A landing that broke a premise is a red line through the rows it stopped, and only those.
 */
export function TapeView({ tape, workload, layout, selected, onSelect, live, ended, total, onSeek }: TapeViewProps) {
	const phone = layout === "phone";
	const [axisRef, width] = useWidth<HTMLDivElement>();
	// The break the pointer or the keyboard is on, and the one that was chosen to stay explained.
	const [hot, setHot] = useState<number | null>(null);
	const [chosen, setChosen] = useState<number | null>(null);
	const pct = (ms: number) => `${(ms / tape.span) * 100}%`;
	const px = (ms: number) => (ms / tape.span) * width;

	const shown: TapeBreak | undefined = tape.breaks.find((line) => line.n === (hot ?? chosen));
	const dimmed = (id: IntentId) => shown !== undefined && !shown.rows.includes(id);
	const needing = tape.rows.filter((row) => row.status === "escalated");
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
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
						return;
					}
					// These arrows move the replay by seconds. They do not go on to the page's "next key moment" key.
					event.preventDefault();
					event.stopPropagation();
					const step = (event.shiftKey ? 10_000 : 1000) * (event.key === "ArrowLeft" ? -1 : 1);
					onSeek(Math.min(total, Math.max(0, tape.now + step)));
				},
				onClick: (event: React.MouseEvent<HTMLDivElement>) => {
					const box = event.currentTarget.getBoundingClientRect();
					onSeek(Math.min(total, Math.max(0, ((event.clientX - box.left) / box.width) * tape.span)));
				},
			}
		: {};

	const flags = tape.breaks.map((line) => {
		const written = !phone && line.flagged;
		const flip = written && px(line.at) + Math.min(260, wide(line.flag) + 8) > width;
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
			{tape.cuts.map((cut) => (
				<span key={cut.at} className="tape-cut" style={{ left: pct(cut.at) }} title={cut.label} />
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

	const density = tape.workload ? (
		<span className="tape-track tape-density" aria-hidden="true">
			{tape.workload.landed.map((count, index) => {
				const from = index * (tape.workload?.bucketMs ?? 0);
				const stale = tape.workload?.stale[index] ?? false;
				if (count === 0 && !stale) {
					return null;
				}
				return (
					<span key={from} className="tape-density-slot" style={{ left: pct(from), width: pct(tape.workload?.bucketMs ?? 0) }} title={`${clock(from)}: ${count} landed${stale ? ", some went stale" : ""}`}>
						{count > 0 ? <span className="tape-density-bar" style={{ height: `${Math.max(12, (count / (tape.workload?.peak ?? 1)) * 100)}%` }} /> : null}
						{stale ? <span className="tape-density-stale" /> : null}
					</span>
				);
			})}
		</span>
	) : null;
	const workloadCounts = workload ? [`${workload.landed} landed`, workload.moving > 0 ? `${workload.moving} in flight` : null, workload.stale > 0 ? `${workload.stale} stale` : null, workload.failed > 0 ? `${workload.failed} gave up` : null].filter(Boolean).join(" · ") : "";

	const rows = (
		<ol className="tape-rows" aria-label="Intents over time">
			{tape.rows.map((row) => (
				<li key={row.id} className="tape-row" data-selected={selected === row.id} data-dimmed={dimmed(row.id)}>
					<button type="button" className="tape-label" data-node-id={`strip-${row.id}`} style={{ ["--band" as string]: BAND[STATUS_LOOK[row.status].band] }} aria-pressed={selected === row.id} aria-label={row.summary} onClick={() => onSelect(row.id)}>
						<span className="tape-band" aria-hidden="true" />
						<span className="tape-name">
							<span className="callsign tape-callsign">{row.callsign}</span>
							{row.races > 0 ? <span className="stamp callsign tape-stamp">R{row.races}</span> : null}
						</span>
						<span className="tape-status">
							<StatusMark status={row.status} size={12} />
						</span>
						{phone ? <Marks row={row} tape={tape} width={width} bare /> : null}
					</button>
					{phone ? null : <Marks row={row} tape={tape} width={width} bare={false} />}
				</li>
			))}
		</ol>
	);

	return (
		<section className="tape" data-layout={layout} data-seekable={seekable} aria-label="Tape">
			{/* Said aloud when it changes: a landing that broke premises, and any Intent that needs a person. */}
			<p className="tape-sr" aria-live="polite">
				{[latest?.sentence, ...needing.map((row) => `${row.callsign} needs you.`)].filter(Boolean).join(" ")}
			</p>

			{phone && tape.breaks.length > 0 ? (
				<ol className="tape-breaklist" aria-label="Landings that broke premises">
					{tape.breaks.map((line) => (
						<li key={line.n}>
							<span className="tape-flag" data-written="false" aria-hidden="true">
								{line.n}
							</span>
							<span>
								{clock(line.at)} · {line.flag} · {line.rows.length} stale
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
							<span className="tape-soft" title="Scripted, not a model">
								{phone ? `scripted, no model · ${workloadCounts}` : workloadCounts}
							</span>
							{phone ? density : null}
						</div>
						{phone ? null : density}
					</div>
				) : null}
				{over}
			</div>

			<footer className="tape-foot">
				{shown ? (
					<p className="tape-sentence" role="status">
						{shown.sentence}
					</p>
				) : null}
				<Key />
			</footer>
		</section>
	);
}
