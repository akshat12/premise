import { useMemo } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { artifactsOperations, BUCKET_MS, INCLUDED_OPERATIONS_PER_MONTH, operationsCost, scaleStats, USD_PER_1000_OPERATIONS } from "../lib/scale";

const whole = new Intl.NumberFormat("en-US");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

function Figure({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col leading-none" style={{ minWidth: 136 }}>
			<span className="callsign" style={{ fontSize: 32, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
				{value}
			</span>
			<span style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>{label}</span>
		</div>
	);
}

/** Landings in each 10 s of the run, as bars. The tallest bar is labelled; the axis runs in real time. */
function Sparkline({ buckets, elapsedMs }: { buckets: readonly number[]; elapsedMs: number }) {
	const peak = Math.max(1, ...buckets);
	const width = 720;
	const height = 96;
	const step = width / buckets.length;
	const bar = Math.max(1, Math.min(32, step - 3));
	const peakAt = buckets.indexOf(peak);
	return (
		<figure style={{ margin: 0 }}>
			<svg viewBox={`0 0 ${width} ${height + 16}`} width="100%" style={{ maxWidth: width, display: "block" }} role="img" aria-label={`Landings in each 10 seconds. The most in one stretch was ${peak}.`}>
				{buckets.map((count, index) => {
					const tall = (count / peak) * height;
					return <rect key={index} x={index * step} y={height - tall + 16} width={bar} height={Math.max(tall, count > 0 ? 2 : 0)} fill="var(--holds)" />;
				})}
				<line x1={0} x2={width} y1={height + 15.5} y2={height + 15.5} stroke="var(--rule)" />
				{peakAt >= 0 && buckets[peakAt] !== undefined && peak > 1 ? (
					<text x={Math.min(width - 4, peakAt * step + bar / 2)} y={11} textAnchor={peakAt * step > width - 40 ? "end" : "middle"} style={{ fontSize: 12, fill: "var(--ink-soft)" }}>
						{peak}
					</text>
				) : null}
			</svg>
			<figcaption className="flex justify-between" style={{ maxWidth: width, fontSize: 12, color: "var(--ink-soft)", marginTop: 4 }}>
				<span>0:00</span>
				<span>Landings in each {BUCKET_MS / 1000} s</span>
				<span>{clock(elapsedMs)}</span>
			</figcaption>
		</figure>
	);
}

interface ScaleViewProps {
	events: readonly PremiseEvent[];
	metrics: Metrics;
	intents: Record<string, IntentView>;
}

/** The run as numbers: how much was asked of Artifacts and the gate, and how fast work landed. */
export function ScaleView({ events, metrics, intents }: ScaleViewProps) {
	const stats = useMemo(() => scaleStats(events), [events]);
	const tally = useMemo(() => {
		const all = Object.values(intents);
		const landed = all.filter((intent) => intent.status === "landed").length;
		const stopped = all.filter((intent) => intent.status === "failed").length;
		return { all: all.length, workload: all.filter((intent) => intent.kind === "workload").length, landed, stopped, flying: all.length - landed - stopped };
	}, [intents]);
	const operations = artifactsOperations(metrics);
	const cost = operationsCost(operations);

	return (
		<section aria-label="Scale" style={{ background: "#fff", border: "1px solid var(--rule)", borderRadius: 3, padding: 24, maxWidth: 960 }}>
			<h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Scale</h2>
			<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
				{tally.all === 0
					? "Nothing has been dispatched yet."
					: `${whole.format(tally.all)} Intents, each on its own Artifacts fork: ${whole.format(tally.all - tally.workload)} from agents and ${whole.format(tally.workload)} scripted workload Intents (real forks and pushes, no model).`}
			</p>
			<div className="flex flex-wrap" style={{ gap: 32, marginTop: 24 }}>
				<Figure label="Forks created" value={whole.format(metrics.forksCreated)} />
				<Figure label="Pushes" value={whole.format(metrics.pushes)} />
				<Figure label="Landings a minute" value={stats.landingsPerMinute.toFixed(1)} />
				<Figure label="Agents active" value={whole.format(metrics.agentsActive)} />
			</div>
			<div style={{ marginTop: 32 }}>
				<Sparkline buckets={stats.buckets} elapsedMs={stats.elapsedMs} />
			</div>
			<dl style={{ margin: "24px 0 0", fontSize: 13, display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 16, rowGap: 8 }}>
				<dt style={{ color: "var(--ink-soft)" }}>Intents</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(tally.landed)} landed, {whole.format(tally.flying)} in flight, {whole.format(tally.stopped)} stopped
				</dd>
				<dt style={{ color: "var(--ink-soft)" }}>Ledger contention</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(stats.contention)} {stats.contention === 1 ? "claim" : "claims"} met another Intent on the same symbol and got Wait, Split or Depend
				</dd>
				<dt style={{ color: "var(--ink-soft)" }}>Premises</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(metrics.premisesBroken)} broken; {whole.format(metrics.rederives.succeeded)} stale Intents settled without a person
				</dd>
				<dt style={{ color: "var(--ink-soft)" }}>Artifacts</dt>
				<dd style={{ margin: 0 }}>
					Operations ≈ {whole.format(operations)} (a fork for each Intent, then a clone and a push for each commit); est. cost ≈ ${cost.toFixed(2)} at ${USD_PER_1000_OPERATIONS.toFixed(2)} per 1,000. The first{" "}
					{whole.format(INCLUDED_OPERATIONS_PER_MONTH)} a month are included.
				</dd>
			</dl>
		</section>
	);
}
