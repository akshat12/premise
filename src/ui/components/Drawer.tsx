import { Button } from "@cloudflare/kumo";
import { Eye, Flag, LinkSimple } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, Premise } from "../../shared/types";
import { ago, groupPremises, SOURCE_TITLE, timelineFor, type TimelineEntry } from "../lib/chips";
import type { DiffState } from "../lib/diff";
import type { IntentView } from "../lib/reduce";
import { OUTSIDE, symbolFile, symbolName, clampDrawerHeight, DRAWER_MIN_HEIGHT, DRAWER_STEP } from "../lib/view";
import { Changes } from "./Changes";
import { RaceIndicator, StatusMark } from "./Strip";

const TONE: Record<TimelineEntry["tone"], string> = { plain: "var(--ink)", good: "var(--holds)", bad: "var(--redpen)", rederive: "var(--bluestamp)", wait: "var(--amber)" };

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
	/** Watching a recording: the diff is the one saved with it. */
	replay?: boolean;
}

/** The height the drawer was last dragged to, or null for the stylesheet's. Kept while the page is open, so it holds from one Intent to the next and across closing the drawer. */
let rememberedHeight: number | null = null;

/** The selected Intent in full: why it did what it did, what it relies on and where each premise came from, its story so far, and what it changed. */
export function Drawer({ intent, events, callsignOf, named, onSelect, onClose, diff, replay = false }: DrawerProps) {
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
				onPointerDown={(event) => {
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
				}}
				onPointerMove={(event) => {
					if (held.current) {
						follow(event);
					}
				}}
				onPointerUp={(event) => {
					if (event.currentTarget.hasPointerCapture(event.pointerId)) {
						event.currentTarget.releasePointerCapture(event.pointerId);
					}
					drag(false);
				}}
				onPointerCancel={() => drag(false)}
				onDoubleClick={() => {
					drag(false);
					resize(null);
				}}
				onKeyDown={onHandleKey}
			/>
			<header className="drawer-head flex items-start justify-between gap-4">
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
				<Button variant="ghost" size="sm" onClick={onClose}>
					Close
				</Button>
			</header>
			<div className={`drawer-columns min-h-0 flex-1${diff === undefined ? "" : " has-changes"}`} data-review={review}>
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
						<Changes key={intent.id} diff={diff} replay={replay} expanded={review} onToggleExpanded={() => setReviewing((now) => !now)} />
					</div>
				)}
			</div>
		</section>
	);
}
