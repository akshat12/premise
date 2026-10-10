import { Button, Tooltip } from "@cloudflare/kumo";
import { AirplaneTakeoff } from "@phosphor-icons/react";
import type { Metrics } from "../../shared/types";
import { type Layout, shortSha } from "../lib/view";
import { Counter } from "./Counter";

export type LiveState = { kind: "live" } | { kind: "reconnecting" } | { kind: "replay"; speed: number; done: boolean; paused?: boolean } | { kind: "still"; at: number };

/** Says what the screen is showing, always: it is never silent about its state. */
export function LivePill({ state }: { state: LiveState }) {
	const look =
		state.kind === "live"
			? { color: "var(--holds)", text: "Live", pulse: true }
			: state.kind === "reconnecting"
				? { color: "var(--amber)", text: "Reconnecting…", pulse: false }
				: state.kind === "still"
					? { color: "var(--bluestamp)", text: `Still · event ${state.at}`, pulse: false }
					: { color: "var(--bluestamp)", text: state.done ? `Replay ${state.speed}× · ended` : state.paused ? `Replay ${state.speed}× · paused` : `Replay ${state.speed}×`, pulse: false };
	return (
		<span role="status" className="inline-flex items-center gap-2" style={{ color: look.color, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
			<span className="live-dot" data-pulse={look.pulse} aria-hidden="true" />
			{look.text}
		</span>
	);
}

interface TopBarProps {
	metrics: Metrics;
	trunk: string | null;
	live: LiveState;
	marker?: string;
	/** "wide" is the one-line bar. The others stack it into three short rows. */
	layout: Layout;
	/** Which view the main area shows (Lanes, Scale, A/B), placed by the app. */
	views: React.ReactNode;
	/** Replay or Live. */
	mode: React.ReactNode;
	/** Speed, pause and play-again, in a replay. */
	transport: React.ReactNode;
	onDispatch: () => void;
}

const markerStyle = { fontSize: 12, color: "var(--ink-soft)", border: "1px solid var(--rule)", borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap", background: "#fff" } as const;

export function TopBar({ metrics, trunk, live, marker, layout, views, mode, transport, onDispatch }: TopBarProps) {
	if (layout !== "wide") {
		// Narrow: what the screen is showing, then where you are and the player, then the numbers.
		return (
			<header className="topbar-narrow">
				<div className="flex items-center gap-3">
					<span className="callsign" style={{ fontSize: 24, lineHeight: 1 }}>
						Premise
					</span>
					<LivePill state={live} />
					<div style={{ marginLeft: "auto", flex: "none" }}>{mode}</div>
				</div>
				<div className="flex items-center gap-2">
					<div className="topbar-scroll">{views}</div>
					<div className="flex items-center gap-1" style={{ marginLeft: "auto", flex: "none" }}>
						{transport}
						{layout === "phone" ? (
							<Button variant="primary" size="sm" shape="square" aria-label="Dispatch tasks" title="Dispatch tasks" onClick={onDispatch}>
								<AirplaneTakeoff size={16} />
							</Button>
						) : (
							<Button variant="primary" size="sm" onClick={onDispatch}>
								Dispatch tasks
							</Button>
						)}
					</div>
				</div>
				<div className="topbar-counters">
					<Counter label="Broken builds on trunk" value={metrics.brokenBuildsOnTrunk} hero alert wrap />
					<Counter label="Human merges" value={metrics.humanMerges} hero alert wrap />
					<Counter label="Landed" value={metrics.intentsLanded} wrap />
					<Counter label="Premises broken" value={metrics.premisesBroken} wrap />
					{layout === "medium" ? (
						<>
							<Counter label="Agents active" value={metrics.agentsActive} wrap />
							<Counter label="Stale, settled" value={metrics.rederives.succeeded} wrap />
						</>
					) : null}
				</div>
				{marker ? (
					<span role="status" className="topbar-marker" style={markerStyle}>
						{marker}
					</span>
				) : null}
			</header>
		);
	}
	return (
		<header className="flex items-center gap-5 px-4" style={{ height: 56, background: "#fff", borderBottom: "1px solid var(--rule)", flex: "none" }}>
			<div className="flex items-baseline gap-3" style={{ flex: "none", whiteSpace: "nowrap" }}>
				<span className="callsign" style={{ fontSize: 24, lineHeight: 1 }}>
					Premise
				</span>
				<Tooltip content={trunk ?? "Nothing has landed yet"}>
					<span className="symbol roomy-only" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
						trunk {shortSha(trunk)}
					</span>
				</Tooltip>
			</div>
			<div style={{ flex: "none" }}>{views}</div>
			<div className="flex items-center gap-5" style={{ minWidth: 0, overflow: "hidden" }}>
				<Counter label="Broken builds on trunk" value={metrics.brokenBuildsOnTrunk} hero alert />
				<Counter label="Human merges" value={metrics.humanMerges} hero alert />
				<span aria-hidden="true" style={{ width: 1, height: 28, background: "var(--rule)" }} />
				<span className="wide-only">
					<Counter label="Agents active" value={metrics.agentsActive} />
				</span>
				<Counter label="Landed" value={metrics.intentsLanded} />
				<Counter label="Premises broken" value={metrics.premisesBroken} />
				<span className="wide-only">
					<Counter label="Stale, settled" value={metrics.rederives.succeeded} />
				</span>
			</div>
			<div className="flex items-center gap-3" style={{ marginLeft: "auto", flex: "none" }}>
				{marker ? (
					<span role="status" style={markerStyle}>
						{marker}
					</span>
				) : null}
				<LivePill state={live} />
				<div className="flex items-center gap-2">
					{mode}
					{transport}
				</div>
				<Button variant="primary" size="sm" onClick={onDispatch}>
					Dispatch tasks
				</Button>
			</div>
		</header>
	);
}
