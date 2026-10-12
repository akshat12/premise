import { useMemo } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { artifactsOperations, BUCKET_MS, INCLUDED_OPERATIONS_PER_MONTH, operationsCost, scaleStats, USD_PER_1000_OPERATIONS } from "../lib/scale";

const whole = new Intl.NumberFormat("en-US");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

function Figure({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col leading-none" style={{ minWidth: 140 }}>
			<span className="figure" style={{ fontSize: 36, lineHeight: 1 }}>
				{value}
			</span>
			<span className="label" style={{ marginTop: 6 }}>
				{label}
			</span>
		</div>
	);
}

/**
 * Landings in each 10 s of the run, as bars. The tallest bar is labelled; the axis runs in real
 * time. Positions are percentages, not a scaled viewBox, so the label stays 12px at any width.
 */
function Sparkline({ buckets, elapsedMs }: { buckets: readonly number[]; elapsedMs: number }) {
	const peak = Math.max(1, ...buckets);
	const height = 96;
	const top = 16;
	const step = 100 / buckets.length;
	// Each bar leaves a sliver of its slot empty, and is never wider than a 32px bar on the full-width chart.
	const bar = Math.min(step * 0.86, 4.4);
	const peakAt = buckets.indexOf(peak);
	const peakX = peakAt * step + bar / 2;
	return (
		<figure style={{ margin: 0, maxWidth: 720 }}>
			<svg width="100%" height={height + top} style={{ display: "block", overflow: "visible" }} role="img" aria-label={`Landings in each 10 seconds. The most in one stretch was ${peak}.`}>
				{buckets.map((count, index) => {
					const tall = (count / peak) * height;
					return <rect key={index} x={`${index * step}%`} y={height - tall + top} width={`${bar}%`} height={Math.max(tall, count > 0 ? 2 : 0)} fill="var(--holds)" />;
				})}
				<line x1="0" x2="100%" y1={height + top - 0.5} y2={height + top - 0.5} stroke="var(--rule)" />
				{peakAt >= 0 && peak > 1 ? (
					<text x={`${Math.min(98, Math.max(2, peakX))}%`} y={11} textAnchor={peakX > 96 ? "end" : peakX < 4 ? "start" : "middle"} style={{ fontSize: 11, fontFamily: "var(--font-label)", fill: "var(--ink-soft)" }}>
						{peak}
					</text>
				) : null}
			</svg>
			<figcaption className="label flex justify-between" style={{ marginTop: 6 }}>
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
	/** Set when these numbers are from a different demo recording than the one playing: its name and where to play it. */
	otherRun?: { name: string; href: string };
}

/** The run as numbers: how much was asked of Artifacts and the gate, and how fast work landed. */
export function ScaleView({ events, metrics, intents, otherRun }: ScaleViewProps) {
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
		<section aria-label="Scale" className="plane bracketed">
			<h2 className="label" style={{ margin: 0 }}>
				At scale
			</h2>
			{otherRun ? (
				<p style={{ margin: "8px 0 0", fontSize: 13, maxWidth: 720, borderLeft: "4px solid var(--holds)", paddingLeft: 12 }}>
					The story is told with four agents, to keep it easy to follow. These numbers are from a larger run of the same system on real Artifacts, shown as it ended.{" "}
					<a href={otherRun.href} style={{ color: "var(--bluestamp)", fontWeight: 600 }}>
						Play that run
					</a>
				</p>
			) : null}
			<p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--ink-soft)" }}>
				{tally.all === 0
					? "Nothing has been dispatched yet."
					: `${whole.format(tally.all)} Intents, each on its own Artifacts fork: ${whole.format(tally.all - tally.workload)} from agents and ${whole.format(tally.workload)} scripted workload Intents (real forks and pushes, no model).`}
			</p>
			<div className="flex flex-wrap" style={{ gap: "24px 32px", marginTop: 24 }}>
				<Figure label="Forks created" value={whole.format(metrics.forksCreated)} />
				<Figure label="Pushes" value={whole.format(metrics.pushes)} />
				<Figure label="Landings a minute" value={stats.landingsPerMinute.toFixed(1)} />
				<Figure label="Agents active" value={whole.format(metrics.agentsActive)} />
			</div>
			<div style={{ marginTop: 32 }}>
				<Sparkline buckets={stats.buckets} elapsedMs={stats.elapsedMs} />
			</div>
			<dl className="facts">
				<dt className="label" style={{ paddingTop: 3 }}>Intents</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(tally.landed)} landed, {whole.format(tally.flying)} in flight, {whole.format(tally.stopped)} did not land
				</dd>
				<dt className="label" style={{ paddingTop: 3 }}>Ledger contention</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(stats.contention)} {stats.contention === 1 ? "claim" : "claims"} met another Intent on the same symbol and got Wait, Split or Depend
				</dd>
				<dt className="label" style={{ paddingTop: 3 }}>Premises</dt>
				<dd style={{ margin: 0 }}>
					{whole.format(metrics.premisesBroken)} broken; {whole.format(metrics.rederives.succeeded)} stale Intents settled without a person
				</dd>
				<dt className="label" style={{ paddingTop: 3 }}>Artifacts</dt>
				<dd style={{ margin: 0 }}>
					Operations ≈ {whole.format(operations)} (a fork for each Intent, then a clone and a push for each commit); est. cost ≈ ${cost.toFixed(2)} at ${USD_PER_1000_OPERATIONS.toFixed(2)} per 1,000. The first{" "}
					{whole.format(INCLUDED_OPERATIONS_PER_MONTH)} a month are included.
				</dd>
			</dl>
		</section>
	);
}
