import { Button, Tooltip } from "@cloudflare/kumo";
import type { Metrics } from "../../shared/types";
import { shortSha } from "../lib/view";
import { Counter } from "./Counter";

export type LiveState = { kind: "live" } | { kind: "reconnecting" } | { kind: "replay"; speed: number; done: boolean } | { kind: "still"; at: number };

/** Says what the screen is showing, always: it is never silent about its state. */
export function LivePill({ state }: { state: LiveState }) {
	const look =
		state.kind === "live"
			? { color: "var(--holds)", text: "Live", pulse: true }
			: state.kind === "reconnecting"
				? { color: "var(--amber)", text: "Reconnecting…", pulse: false }
				: state.kind === "still"
					? { color: "var(--bluestamp)", text: `Still · event ${state.at}`, pulse: false }
					: { color: "var(--bluestamp)", text: state.done ? `Replay ${state.speed}× · ended` : `Replay ${state.speed}×`, pulse: false };
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
	/** Source and speed controls, placed by the app. */
	controls: React.ReactNode;
	onDispatch: () => void;
}

export function TopBar({ metrics, trunk, live, marker, controls, onDispatch }: TopBarProps) {
	return (
		<header className="flex items-center gap-5 px-4" style={{ height: 56, background: "#fff", borderBottom: "1px solid var(--rule)", flex: "none" }}>
			<div className="flex items-baseline gap-3" style={{ flex: "none", whiteSpace: "nowrap" }}>
				<span className="callsign" style={{ fontSize: 24, lineHeight: 1 }}>
					Premise
				</span>
				<Tooltip content={trunk ?? "Nothing has landed yet"}>
					<span className="symbol" style={{ fontSize: 12, color: "var(--ink-soft)" }}>
						trunk {shortSha(trunk)}
					</span>
				</Tooltip>
			</div>
			<div className="flex items-center gap-5" style={{ minWidth: 0, overflow: "hidden" }}>
				<Counter label="Broken builds on trunk" value={metrics.brokenBuildsOnTrunk} hero alert />
				<Counter label="Human merges" value={metrics.humanMerges} hero alert />
				<span aria-hidden="true" style={{ width: 1, height: 28, background: "var(--rule)" }} />
				<Counter label="Agents active" value={metrics.agentsActive} />
				<Counter label="Landed" value={metrics.intentsLanded} />
				<Counter label="Premises broken" value={metrics.premisesBroken} />
				<Counter label="Stale, settled" value={metrics.rederives.succeeded} />
			</div>
			<div className="flex items-center gap-3" style={{ marginLeft: "auto", flex: "none" }}>
				{marker ? (
					<span style={{ fontSize: 12, color: "var(--ink-soft)", border: "1px solid var(--rule)", borderRadius: 3, padding: "2px 6px", whiteSpace: "nowrap" }}>{marker}</span>
				) : null}
				<LivePill state={live} />
				{controls}
				<Button variant="primary" size="sm" onClick={onDispatch}>
					Dispatch tasks
				</Button>
			</div>
		</header>
	);
}
