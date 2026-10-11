import { Button } from "@cloudflare/kumo";
import { Eye, Flag, LinkSimple } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { IntentId, Premise } from "../../shared/types";
import { ago, groupPremises, SOURCE_TITLE, timelineFor, type TimelineEntry } from "../lib/chips";
import type { DiffState } from "../lib/diff";
import type { IntentView } from "../lib/reduce";
import { callsign, OUTSIDE, symbolFile, symbolName } from "../lib/view";
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
	return (
		<section className="drawer flex flex-col" data-review={review} aria-label={`${callsign(intent)} details`}>
			<header className="drawer-head flex items-start justify-between gap-4">
				<div style={{ minWidth: 0 }}>
					<div className="flex items-center gap-3">
						<span className="callsign" style={{ fontSize: 20, lineHeight: 1 }}>
							{callsign(intent)}
						</span>
						<StatusMark status={intent.status} />
						<RaceIndicator intent={intent} />
					</div>
					<p style={{ fontSize: 13, margin: "4px 0 0", color: stale ? "var(--redpen)" : "var(--ink-soft)" }}>{stale ? "A premise broke: re-deriving on new trunk" : intent.goal}</p>
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
