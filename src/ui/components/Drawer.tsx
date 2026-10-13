import { CaretDown, DotsSix, Eye, Flag, LinkSimple } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, Premise } from "../../shared/types";
import { ago, groupPremises, SOURCE_TITLE, timelineFor, type TimelineEntry } from "../lib/chips";
import type { ChangesFrom, DiffState } from "../lib/diff";
import type { IntentView } from "../lib/reduce";
import { OUTSIDE, symbolFile, symbolName, clampDrawerHeight, columnEdges, dragColumns, DRAWER_COLUMN_STEP, DRAWER_COLUMNS, DRAWER_MIN_HEIGHT, DRAWER_STEP, type Layout } from "../lib/view";
import { Changes } from "./Changes";
import { RaceIndicator, StatusMark } from "./Strip";

// The timeline's colours are the lanes': green landed or passed, red stopped or failed, yellow being redone. Waiting is not a colour.
const TONE: Record<TimelineEntry["tone"], string> = { plain: "var(--ink)", good: "var(--holds)", bad: "var(--redpen)", rederive: "var(--amber)", wait: "var(--ink-soft)" };

const columnTitle = { fontSize: 13, fontWeight: 600, margin: "0 0 8px" } as const;
const muted = { fontSize: 12, color: "var(--ink-soft)" } as const;

function PremiseRow({ premise, callsignOf, named, onSelect }: { premise: Premise; callsignOf: (id: IntentId) => string; named: (text: string) => string; onSelect: (id: IntentId) => void }) {
	const broken = premise.state === "broken";
	const by = premise.brokenBy?.intentId;
	return (
		<li style={{ padding: "4px 0", borderBottom: "1px solid var(--rule)" }}>
			<span className="flex items-baseline justify-between gap-2">
				<span className="symbol" style={{ fontSize: 12, color: broken ? "var(--redpen)" : "var(--ink)", textDecoration: broken ? "line-through" : "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
					{symbolName(premise.symbol)}
				</span>
				<span className="symbol" style={{ ...muted, flex: "none" }}>
					{symbolFile(premise.symbol)}
					{premise.surfaceHash ? ` · ${premise.surfaceHash.slice(0, 8)}` : ""}
				</span>
			</span>
			{premise.assertion ? <span style={{ display: "block", fontSize: 12, color: broken ? "var(--redpen)" : "var(--ink)" }}>“{premise.assertion.description}”</span> : null}
			{broken ? (
				<span style={{ display: "block", fontSize: 12, color: "var(--redpen)" }}>
					Broken: {named(premise.brokenBy?.reason ?? "it no longer holds")}
					{by !== undefined && by !== OUTSIDE ? (
						<button type="button" onClick={() => onSelect(by)} className="inline-flex items-center gap-1" style={{ marginLeft: 6, border: 0, background: "none", padding: 0, color: "var(--bluestamp)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
							<LinkSimple size={11} aria-hidden="true" />
							{callsignOf(by)}
						</button>
					) : null}
				</span>
			) : null}
		</li>
	);
}

interface DrawerProps {
	intent: IntentView;
	events: readonly PremiseEvent[];
	callsignOf: (id: IntentId) => string;
	/** Rewrites Intent ids inside a message as callsigns. */
	named: (text: string) => string;
	onSelect: (id: IntentId) => void;
	onClose: () => void;
	/**
	 * What the Intent changed, from `useIntentDiff` (lib/useIntentDiff.ts): a diff, null when there
	 * is none, or "loading". Left out, the drawer has no Changes column.
	 */
	diff?: DiffState;
	/** Where `diff` comes from: the Intent's fork now, the recording, or a past run's trunk. It decides how the Changes column describes it. */
	changesFrom?: ChangesFrom;
	/** Wide: four columns side by side. Medium: three, with Changes under them. Phone: one column, and nothing to drag. */
	layout?: Layout;
}

/** The height the drawer was last dragged to, or null for the stylesheet's. Kept while the page is open, so it holds from one Intent to the next and across closing the drawer. */
let rememberedHeight: number | null = null;
/** The columns' shares of the width, as last dragged. Kept the same way. */
let rememberedColumns: number[] = [...DRAWER_COLUMNS];

const COLUMN_NAMES = ["Why", "Relies on", "Timeline", "Changes"];

/** The selected Intent in full: why it did what it did, what it relies on and where each premise came from, its story so far, and what it changed. */
export function Drawer({ intent, events, callsignOf, named, onSelect, onClose, diff, changesFrom = "live", layout = "wide" }: DrawerProps) {
	// Reviewing: the Changes column has the whole drawer. It stays that way from one Intent to the next, until the drawer is closed.
	const [reviewing, setReviewing] = useState(false);
	const review = reviewing && diff !== undefined;
	const groups = useMemo(() => groupPremises(intent.premises), [intent.premises]);
	const timeline = useMemo(() => {
		// The gate names a failed assertion by id; the reader gets the sentence the agent wrote.
		const described = new Map(intent.premises.flatMap((premise) => (premise.assertion ? [[premise.assertion.id, premise.assertion.description] as const] : [])));
		return timelineFor(events, intent.id, (assertionId) => described.get(assertionId));
	}, [events, intent.id, intent.premises]);
	const now = events.at(-1)?.ts ?? 0;
	const stale = intent.status === "stale" || intent.status === "rederiving";

	// The drawer's top edge can be dragged. Its height is remembered for as long as the page is open,
	// and a double-click on the handle goes back to the size the stylesheet gives it.
	const [height, setHeight] = useState<number | null>(rememberedHeight);
	const [dragging, setDragging] = useState(false);
	const section = useRef<HTMLElement>(null);
	const lastPress = useRef(-1000);
	// Read by the move handler. A ref, because a move can arrive before the render that follows a press.
	const held = useRef(false);
	const drag = (on: boolean) => {
		held.current = on;
		setDragging(on);
	};
	const resize = (wanted: number | null) => {
		rememberedHeight = wanted === null ? null : clampDrawerHeight(wanted, window.innerHeight);
		setHeight(rememberedHeight);
	};
	// The drawer sits at the bottom of the window, so its height is the distance from the pointer to the bottom.
	const follow = (event: React.PointerEvent) => resize((section.current?.getBoundingClientRect().bottom ?? window.innerHeight) - event.clientY);
	const current = () => height ?? section.current?.getBoundingClientRect().height ?? 280;
	const onHandleKey = (event: React.KeyboardEvent) => {
		const to = event.key === "ArrowUp" ? current() + DRAWER_STEP : event.key === "ArrowDown" ? current() - DRAWER_STEP : event.key === "Home" ? window.innerHeight : event.key === "End" ? 0 : null;
		if (to !== null) {
			event.preventDefault();
			event.stopPropagation();
			resize(to);
		}
	};
	// The same press, move and release work on the whole top edge and on the grip in the tab.
	const heightDrag = {
		onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
			// Two presses in quick succession put the drawer back to its usual size. (Timed here rather than
			// left to the double-click event, which a captured pointer does not always deliver.)
			const again = event.timeStamp - lastPress.current < 350;
			lastPress.current = event.timeStamp;
			if (again) {
				drag(false);
				resize(null);
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			drag(true);
			event.preventDefault();
		},
		onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
			if (held.current) {
				follow(event);
			}
		},
		onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			drag(false);
		},
		onPointerCancel: () => drag(false),
		onDoubleClick: () => {
			drag(false);
			resize(null);
		},
	};

	// The dividers between the columns can be dragged too. How many columns sit side by side depends on the
	// layout: four when wide, three when Changes goes under them, and none to drag when they are stacked or
	// when Changes has the panel to itself.
	const [columns, setColumns] = useState<number[]>(rememberedColumns);
	const grid = useRef<HTMLDivElement>(null);
	const beside = review || layout === "phone" ? 0 : layout === "wide" && diff !== undefined ? 4 : 3;
	const shown = columns.slice(0, beside);
	const edges = columnEdges(shown);
	// Where a column drag began: which divider, where the pointer was, and the shares at that moment.
	const columnDrag = useRef<{ index: number; x: number; from: number[] } | null>(null);
	const [heldColumn, setHeldColumn] = useState<number | null>(null);
	const lastColumnPress = useRef({ index: -1, at: -1000 });
	const setShown = (next: number[]) => {
		rememberedColumns = [...next, ...columns.slice(next.length)];
		setColumns(rememberedColumns);
	};
	const resetColumns = () => {
		rememberedColumns = [...DRAWER_COLUMNS];
		setColumns(rememberedColumns);
	};
	const endColumnDrag = () => {
		columnDrag.current = null;
		setHeldColumn(null);
		drag(false);
	};
	const columnHandle = (index: number) => ({
		onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
			const again = lastColumnPress.current.index === index && event.timeStamp - lastColumnPress.current.at < 350;
			lastColumnPress.current = { index, at: event.timeStamp };
			if (again) {
				endColumnDrag();
				resetColumns();
				return;
			}
			event.currentTarget.setPointerCapture(event.pointerId);
			columnDrag.current = { index, x: event.clientX, from: shown };
			setHeldColumn(index);
			setDragging(true);
			event.preventDefault();
		},
		onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
			const begun = columnDrag.current;
			if (begun !== null) {
				// Measured from where the drag began, so the divider stays under the pointer.
				setShown(dragColumns(begun.from, begun.index, event.clientX - begun.x, grid.current?.getBoundingClientRect().width ?? 0));
			}
		},
		onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			endColumnDrag();
		},
		onPointerCancel: endColumnDrag,
		onDoubleClick: () => {
			endColumnDrag();
			resetColumns();
		},
		// A second way to hear a double-click: the click that ends it says it is the second. (Some browsers
		// deliver one press for a double-click, and no double-click event to an element that captured the pointer.)
		onClick: (event: React.MouseEvent<HTMLElement>) => {
			if (event.detail >= 2) {
				endColumnDrag();
				resetColumns();
			}
		},
		onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
			const step = event.key === "ArrowLeft" ? -DRAWER_COLUMN_STEP : event.key === "ArrowRight" ? DRAWER_COLUMN_STEP : null;
			if (step !== null) {
				// Not the page's keys here: on a divider the arrows move the divider, not the story.
				event.preventDefault();
				event.stopPropagation();
				setShown(dragColumns(shown, index, step, grid.current?.getBoundingClientRect().width ?? 0));
			} else if (event.key === "Home") {
				event.preventDefault();
				event.stopPropagation();
				resetColumns();
			}
		},
	});

	return (
		<section ref={section} className="drawer flex flex-col" data-review={review} data-dragging={dragging} style={height === null ? undefined : { height }} aria-label={`${callsignOf(intent.id)} details`}>
			<div
				className="drawer-handle"
				role="separator"
				aria-orientation="horizontal"
				aria-label="Resize the details panel"
				aria-valuenow={Math.round(current())}
				aria-valuemin={DRAWER_MIN_HEIGHT}
				aria-valuemax={Math.max(DRAWER_MIN_HEIGHT, Math.round(clampDrawerHeight(Number.MAX_SAFE_INTEGER, window.innerHeight)))}
				tabIndex={0}
				title="Drag to resize. Double-click to reset."
				{...heightDrag}
				onKeyDown={onHandleKey}
			/>
			{/* The tab on the top edge: the grip to drag the panel by, and Close beside it, so closing is where the hand already is. */}
			<div className="drawer-tab">
				<span className="drawer-grip" aria-hidden="true" title="Drag to resize. Double-click to reset." {...heightDrag}>
					<DotsSix size={18} weight="bold" />
				</span>
				<button type="button" className="drawer-close" onClick={onClose} title="Close (Esc)">
					Close
					<CaretDown size={12} weight="bold" aria-hidden="true" />
				</button>
			</div>
			<header className="drawer-head">
				<div style={{ minWidth: 0 }}>
					<div className="flex items-center gap-3">
						<span className="callsign" style={{ fontSize: 13, lineHeight: 1 }}>
							{callsignOf(intent.id)}
						</span>
						<StatusMark status={intent.status} />
						<RaceIndicator intent={intent} />
					</div>
					<p style={{ fontSize: 13, margin: "4px 0 0", color: stale ? "var(--redpen)" : "var(--ink-soft)" }}>{stale ? "A premise broke: this Intent is stopped until its work is redone on the new trunk" : intent.goal}</p>
				</div>
			</header>
			<div
				ref={grid}
				className={`drawer-columns min-h-0 flex-1${diff === undefined ? "" : " has-changes"}`}
				data-review={review}
				// The stylesheet's shares, until a divider has been dragged. (Stacked columns and the review take no template.)
				style={beside === 0 ? undefined : { gridTemplateColumns: shown.map((share) => `minmax(0, ${share}fr)`).join(" ") }}
			>
				<div className="drawer-column">
					<h3 style={columnTitle}>Why</h3>
					{intent.why.length > 0 ? (
						<ol style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
							{intent.why.slice(0, 3).map((line) => (
								<li key={line} style={{ marginBottom: 4 }}>
									{line}
								</li>
							))}
						</ol>
					) : (
						<p style={muted}>It has not said why yet.</p>
					)}
					{stale ? <p style={{ ...muted, marginTop: 8 }}>{intent.goal}</p> : null}
					<p style={{ ...muted, marginTop: 8 }}>
						Changes {intent.claims.length === 0 ? "nothing yet" : intent.claims.map((claim) => `${symbolName(claim.symbol)}${claim.mode === "interface" ? " (interface)" : ""}`).join(", ")}.
					</p>
				</div>
				<div className="drawer-column">
					<h3 style={columnTitle}>Relies on</h3>
					{groups.length === 0 ? <p style={muted}>Nothing recorded yet.</p> : null}
					{groups.map((group) => (
						<div key={group.source} style={{ marginBottom: 12 }}>
							<p className="flex items-center gap-1" style={{ fontSize: 12, fontWeight: 600, margin: 0 }}>
								{group.source === "asserted" ? <Flag size={12} weight="fill" aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
								{SOURCE_TITLE[group.source].title} ({group.premises.length}
								{group.broken > 0 ? `, ${group.broken} broken` : ""})
							</p>
							<p style={{ ...muted, margin: "0 0 2px" }}>{SOURCE_TITLE[group.source].means}</p>
							<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
								{group.premises.map((premise) => (
									<PremiseRow key={`${premise.symbol}:${premise.assertion?.id ?? ""}`} premise={premise} callsignOf={callsignOf} named={named} onSelect={onSelect} />
								))}
							</ul>
						</div>
					))}
				</div>
				<div className="drawer-column">
					<h3 style={columnTitle}>Timeline</h3>
					<ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
						{timeline.map((entry) => (
							<li key={entry.seq} className="flex items-baseline justify-between gap-3" style={{ padding: "3px 0", fontSize: 12 }}>
								<span style={{ color: TONE[entry.tone], minWidth: 0 }}>
									{named(entry.text)}
									{entry.other !== undefined && entry.other !== OUTSIDE ? (
										<button type="button" onClick={() => onSelect(entry.other as IntentId)} style={{ marginLeft: 6, border: 0, background: "none", padding: 0, color: "var(--bluestamp)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
											{callsignOf(entry.other)}
										</button>
									) : null}
								</span>
								<span style={{ ...muted, flex: "none" }} title={new Date(entry.ts).toISOString()}>
									{ago(entry.ts, now)}
								</span>
							</li>
						))}
					</ol>
				</div>
				{diff === undefined ? null : (
					<div className="drawer-column changes-column">
						{/* Keyed by Intent, so the files a reader opened for one are not left open for the next. */}
						<Changes key={intent.id} diff={diff} from={changesFrom} expanded={review} onToggleExpanded={() => setReviewing((now) => !now)} />
					</div>
				)}
				{/* The dividers, after the columns so the columns stay next to each other in the markup. Each sits on a boundary. */}
				{edges.map((edge, index) => (
					<div
						key={COLUMN_NAMES[index]}
						className="column-handle"
						role="separator"
						aria-orientation="vertical"
						aria-label={`Resize the ${COLUMN_NAMES[index]} and ${COLUMN_NAMES[index + 1]} columns`}
						aria-valuenow={Math.round(edge)}
						aria-valuemin={0}
						aria-valuemax={100}
						tabIndex={0}
						title="Drag to resize the columns. Double-click to reset."
						data-held={heldColumn === index}
						style={{ left: `${edge}%` }}
						{...columnHandle(index)}
					/>
				))}
			</div>
		</section>
	);
}
