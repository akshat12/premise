import { Flow } from "@cloudflare/kumo";
import { CheckCircle, GitCommit, ListChecks, ShieldCheck, Stack, Warning, XCircle } from "@phosphor-icons/react";
import type { IntentId, SymbolId } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { baysReached, callsign, type Lanes as LaneData, shortSha, touches } from "../lib/view";
import { Strip } from "./Strip";

const BAY = { check: 76, gate: 70, trunk: 92 };
const BACKLOG = 70;
// Flow puts 64px between nodes and clips what does not fit, so the strip takes whatever width is
// left after the backlog, the three bays and the four gaps: all the bays stay on screen from 1280 up.
const FIXED = BACKLOG + BAY.check + BAY.gate + BAY.trunk + 4 * 64 + 8;
export const stripWidthFor = (boardWidth: number) => Math.max(340, Math.min(640, Math.floor(boardWidth - FIXED)));

function CheckBay({ intent }: { intent: IntentView }) {
	const reached = baysReached(intent).check;
	const quarantined = intent.status === "quarantined";
	const passed = baysReached(intent).gate;
	return (
		<div className="bay" data-reached={reached} title={quarantined ? "It edited symbols outside its claims" : undefined} style={{ width: BAY.check, ...(quarantined ? { color: "var(--amber)", borderColor: "var(--amber)" } : {}) }}>
			{quarantined ? <Warning size={14} weight="bold" aria-hidden="true" /> : passed ? <CheckCircle size={14} weight="bold" color="var(--holds)" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
			Check
		</div>
	);
}

function GateBay({ intent }: { intent: IntentView }) {
	const reached = baysReached(intent).gate;
	const report = intent.gate;
	const failed = report !== undefined && !report.ok && intent.status !== "landed";
	const passed = intent.status === "landed" || (report?.ok ?? false);
	const words = !failed
		? "Gate"
		: report?.textConflict
			? "Gate: text conflict"
			: !report?.typecheck.ok
				? "Gate: type error"
				: (report?.assertions.failed.length ?? 0) > 0
					? "Gate: premise fails"
					: "Gate: check fails";
	return (
		<div className="bay" data-reached={reached} title={failed ? words : undefined} aria-label={words} style={{ width: BAY.gate, ...(failed ? { color: "var(--redpen)", borderColor: "var(--redpen)" } : {}) }}>
			{failed ? <XCircle size={14} weight="bold" aria-hidden="true" /> : passed ? <CheckCircle size={14} weight="bold" color="var(--holds)" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
			Gate
		</div>
	);
}

function TrunkBay({ intent }: { intent: IntentView }) {
	const landed = intent.status === "landed";
	return (
		<div className="bay" data-reached={landed} style={{ width: BAY.trunk, ...(landed ? { color: "var(--holds)", borderColor: "var(--holds)" } : {}) }}>
			<GitCommit size={14} weight={landed ? "bold" : "regular"} aria-hidden="true" />
			{landed ? <span className="symbol">{shortSha(intent.headCommit)}</span> : "Trunk"}
		</div>
	);
}

function WorkloadStrip({ workload }: { workload: NonNullable<LaneData["workload"]> }) {
	const parts = [`${workload.landed} landed`, workload.moving > 0 ? `${workload.moving} on their way` : null, workload.stale > 0 ? `${workload.stale} stale` : null, workload.failed > 0 ? `${workload.failed} gave up` : null].filter(Boolean);
	return (
		<div className="strip" data-kind="workload" style={{ ["--band" as string]: "var(--bluestamp)", gridTemplateColumns: "6px minmax(0, 1fr)" }} role="group" aria-label={`Scripted workload, ${workload.total} Intents: ${parts.join(", ")}`}>
			<span className="strip-band" aria-hidden="true" />
			<div className="flex items-center gap-4" style={{ padding: "0 12px" }}>
				<span className="flex items-center gap-2">
					<Stack size={18} aria-hidden="true" />
					<span className="callsign" style={{ fontSize: 20, lineHeight: 1 }}>
						WORKLOAD {workload.total}
					</span>
				</span>
				<span style={{ fontSize: 13, color: "var(--ink-soft)" }}>Scripted, not a model. {parts.join(" · ")}</span>
			</div>
		</div>
	);
}

interface LanesProps {
	lanes: LaneData;
	/** The width available to the board, in pixels. */
	width: number;
	selected: IntentId | null;
	hoverSymbol: SymbolId | null;
	shared: ReadonlySet<SymbolId>;
	onSelect: (id: IntentId) => void;
	onHoverSymbol: (symbol: SymbolId | null) => void;
}

/**
 * The strip board: one lane per agent Intent, moving through the bays Check, Gate and Trunk, and
 * one lane for the whole scripted workload. Kumo's Flow draws the connectors; a bay the Intent
 * has not reached is disabled.
 */
export function Lanes({ lanes, width, selected, hoverSymbol, shared, onSelect, onHoverSymbol }: LanesProps) {
	const STRIP_WIDTH = stripWidthFor(width);
	const byId = new Map(lanes.agents.map((intent) => [intent.id, intent]));
	const callsignOf = (id: IntentId) => {
		const intent = byId.get(id);
		return intent ? callsign(intent) : id;
	};
	return (
		<Flow canvas={false} align="start" padding={{ x: 0, y: 0 }} className="premise-flow">
			<Flow.Node
				render={
					<div className="bay" data-reached="true" style={{ height: 48, width: BACKLOG }}>
						Backlog
					</div>
				}
			/>
			<Flow.Parallel>
				{lanes.agents.map((intent) => {
					const bays = baysReached(intent);
					return (
						<Flow.List key={intent.id}>
							<Flow.Node
								id={`strip-${intent.id}`}
								render={
									<div style={{ width: STRIP_WIDTH }}>
										<Strip intent={intent} shared={shared} selected={selected === intent.id} dimmed={hoverSymbol !== null && !touches(intent, hoverSymbol)} callsignOf={callsignOf} onSelect={onSelect} onHoverSymbol={onHoverSymbol} />
									</div>
								}
							/>
							<Flow.Node
								disabled={!bays.check}
								render={
									<div>
										<CheckBay intent={intent} />
									</div>
								}
							/>
							<Flow.Node
								disabled={!bays.gate}
								render={
									<div>
										<GateBay intent={intent} />
									</div>
								}
							/>
							<Flow.Node
								disabled={!bays.trunk}
								render={
									<div>
										<TrunkBay intent={intent} />
									</div>
								}
							/>
						</Flow.List>
					);
				})}
				{lanes.workload ? (
					<Flow.List>
						<Flow.Node
							render={
								<div style={{ width: STRIP_WIDTH }}>
									<WorkloadStrip workload={lanes.workload} />
								</div>
							}
						/>
						<Flow.Node
							disabled={lanes.workload.landed === 0}
							render={
								<div>
									<div className="bay" data-reached={lanes.workload.landed > 0} style={{ minWidth: BAY.trunk, ...(lanes.workload.landed > 0 ? { color: "var(--holds)", borderColor: "var(--holds)" } : {}) }}>
										<GitCommit size={14} aria-hidden="true" />
										{lanes.workload.landed > 0 ? `${lanes.workload.landed} on trunk` : "Trunk"}
									</div>
								</div>
							}
						/>
					</Flow.List>
				) : null}
			</Flow.Parallel>
		</Flow>
	);
}
