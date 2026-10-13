import { useMemo } from "react";
import type { PremiseEvent } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { artifactsOperations, BUCKET_MS, INCLUDED_OPERATIONS_PER_MONTH, operationsCost, scaleStats, USD_PER_1000_OPERATIONS } from "../lib/scale";

const whole = new Intl.NumberFormat("en-US");
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

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
				<span>Landings in each {BUCKET_MS / 1000} seconds</span>
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

function Reading({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "accent" | "good" }) {
	return (
		<div className="figures-cell" data-tone={tone}>
			<span className="label">{label}</span>
			<span className="figure">{value}</span>
			<span className="label figures-sub">{sub}</span>
		</div>
	);
}

/**
 * One larger run in a headline, four numbers and a chart: how many Intents, how many landed, how
 * fast, and whether anything broken got through. Everything else is under "More numbers".
 */
export function ScaleView({ events, metrics, intents, otherRun }: ScaleViewProps) {
	const stats = useMemo(() => scaleStats(events), [events]);
	const tally = useMemo(() => {
		const all = Object.values(intents);
		const landed = all.filter((intent) => intent.status === "landed").length;
		const failed = all.filter((intent) => intent.status === "failed").length;
		const workload = all.filter((intent) => intent.kind === "workload").length;
		return { all: all.length, agents: all.length - workload, workload, landed, failed, flying: all.length - landed - failed };
	}, [intents]);
	// Why the ones that did not land did not: the log says, in the note on each one's last status.
	const reasons = useMemo(() => {
		let waited = 0;
		let runner = 0;
		for (const event of events) {
			if (event.t === "intent.status" && event.status === "failed") {
				if (/still holds/.test(event.note ?? "")) {
					waited++;
				} else if (/illegal transition/.test(event.note ?? "")) {
					runner++;
				}
			}
		}
		return { waited, runner };
	}, [events]);
	const operations = artifactsOperations(metrics);
	const cost = operationsCost(operations);
	const problems = metrics.behaviouralRegressionsOnTrunk + metrics.brokenBuildsOnTrunk;
	const over = tally.all > 0 && tally.flying === 0;
	const count = (n: number, one: string, many = `${one}s`) => `${whole.format(n)} ${n === 1 ? one : many}`;

	if (tally.all === 0) {
		return (
			<section aria-label="At scale" className="plane bracketed">
				<h2 className="label plane-kicker">At scale</h2>
				<p className="plane-title">Nothing has been dispatched yet.</p>
				<p className="plane-lede">Once a run starts, this page shows how many Intents it has, how many have landed and how fast.</p>
			</section>
		);
	}
	return (
		<section aria-label="At scale" className="plane bracketed">
			<h2 className="label plane-kicker">At scale</h2>
			<p className="plane-title">
				{count(tally.agents, "agent")}
				{tally.workload > 0 ? ` and ${count(tally.workload, "scripted Intent")}` : ""}, through one gate.
			</p>
			<p className="plane-lede">
				Each worked on its own fork on Cloudflare Artifacts. {whole.format(tally.landed)} {over ? "landed" : "have landed"} in {clock(stats.elapsedMs)}
				{problems === 0 ? `, and nothing broken ${over ? "reached" : "has reached"} trunk.` : `, and ${count(problems, "problem")} reached trunk.`}
				{otherRun ? (
					<>
						{" "}
						This is a larger run of the same system that tells the story.{" "}
						<a href={otherRun.href} className="plane-link">
							Play this run
						</a>
					</>
				) : null}
			</p>
			<div className="figures plane-figures" aria-label="The run in numbers">
				<Reading label="Intents" value={whole.format(tally.all)} sub="each on its own fork" />
				<Reading label="Landed" value={whole.format(tally.landed)} sub={`of ${whole.format(tally.all)}`} tone="good" />
				<Reading label="Landings a minute" value={stats.landingsPerMinute.toFixed(0)} sub="through one gate" />
				<Reading label="Problems on trunk" value={whole.format(problems)} sub={problems > 0 ? "reached trunk broken" : over ? "nothing got through" : "none so far"} {...(problems > 0 ? { tone: "accent" as const } : {})} />
			</div>
			<div style={{ marginTop: 28 }}>
				<Sparkline buckets={stats.buckets} elapsedMs={stats.elapsedMs} />
			</div>
			{tally.failed > 0 ? (
				<p className="plane-note">
					<strong>{count(tally.failed, "Intent")} did not land.</strong>{" "}
					{reasons.waited > 0 ? `${whole.format(reasons.waited)} gave up waiting for a symbol that another Intent was changing. ` : ""}
					{reasons.runner > 0 ? `${whole.format(reasons.runner)} were failed by a fault in the scripted runner${otherRun ? ", fixed since this run was recorded" : ""}. ` : ""}
					Their work is not on trunk.
				</p>
			) : null}
			{tally.workload > 0 ? <p className="plane-small">The scripted Intents are generated edits with real forks, pushes and landings. No model writes them, and they are labelled as scripted wherever they appear.</p> : null}
			<details className="more">
				<summary className="label">More numbers</summary>
				<dl className="facts">
					<dt className="label">Artifacts</dt>
					<dd>
						{whole.format(metrics.forksCreated)} forks and {whole.format(metrics.pushes)} pushes. About {whole.format(operations)} operations (a fork for each Intent, then a clone and a push for each commit): about ${cost.toFixed(2)} at $
						{USD_PER_1000_OPERATIONS.toFixed(2)} per 1,000, with the first {whole.format(INCLUDED_OPERATIONS_PER_MONTH)} a month included.
					</dd>
					<dt className="label">Two wanting one symbol</dt>
					<dd>
						{count(stats.contended, "Intent")} wanted a symbol another Intent held. The ledger answered Wait, Split or Depend {count(stats.contention, "time")}.
					</dd>
					<dt className="label">Premises</dt>
					<dd>
						{whole.format(metrics.premisesBroken)} broke. {count(metrics.rederives.succeeded, "stopped Intent")} went on to land without a person.
					</dd>
				</dl>
			</details>
		</section>
	);
}
