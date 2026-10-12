// Runs the A/B comparison against a deployed (or local) Worker and writes the report.
//
//   npx tsx scripts/ab.ts --url https://premise.<account>.workers.dev [--n 100] [--seeds 7,11,23] [--out docs/ab-results]
//
// Three landing rules (typecheck only, a queue that also runs the tests, Premise) are each run on
// every seed, one after another. The admin token comes from the ADMIN_TOKEN environment variable,
// or else from .env.deployed (a deployed Worker) or .dev.vars (localhost).
// Each mode resets the demo first, so do not run this while a demo you care about is on screen.
import { writeFileSync } from "node:fs";
import { AB_MODES, type AbMode, buildReport, type ModeResult, renderMarkdown, type Trial } from "../src/worker/ab/report";
import { adminToken, arg } from "./lib/admin";

const url = (arg("url") ?? process.env.URL ?? "").replace(/\/$/, "");
const n = Number(arg("n") ?? "100");
const seeds = (arg("seeds") ?? arg("seed") ?? "7").split(",").map((seed) => Number(seed.trim()));
const timeoutMs = Number(arg("timeout-minutes") ?? "40") * 60_000;
if (!url || seeds.some((seed) => !Number.isFinite(seed))) {
	throw new Error("Usage: npx tsx scripts/ab.ts --url <worker url> [--n 100] [--seeds 7,11,23]");
}
const headers = { "x-admin-token": process.env.ADMIN_TOKEN ?? adminToken(url), "content-type": "application/json" };

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!response.ok) {
		throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	return (await response.json()) as T;
}

async function runMode(mode: AbMode, seed: number): Promise<ModeResult> {
	const started = Date.now();
	await post("/api/admin/ab", { mode, n, seed });
	console.log(`${mode} (seed ${seed}): started with ${n} workload Intents`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const state = await post<{ quiet: boolean; counts: Record<string, number>; result?: ModeResult }>("/api/admin/ab/result", { mode, n, seed });
		const summary = Object.entries(state.counts).sort().map(([status, count]) => `${status}=${count}`).join(" ");
		console.log(`${mode} (seed ${seed}): ${Math.round((Date.now() - started) / 1000)}s ${summary}`);
		if (state.quiet && state.result) {
			return state.result;
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`${mode} (seed ${seed}) did not go quiet within ${timeoutMs / 60_000} minutes`);
		}
	}
}

// The committed results are from real Artifacts, and the Compared view shows them. A run against a local
// Worker is written beside them (git-ignored), so trying the script does not replace those numbers.
const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const out = arg("out") ?? (local ? "docs/ab-results.local" : "docs/ab-results");
const trials: Trial[] = [];
for (const seed of seeds) {
	const results = {} as Record<AbMode, ModeResult>;
	for (const mode of AB_MODES) {
		results[mode] = await runMode(mode, seed);
	}
	trials.push({ seed, ...results });
	// Written after every seed, so a long run that is cut short still leaves a report of what finished.
	const report = buildReport(trials);
	const date = new Date().toISOString().slice(0, 10);
	writeFileSync(`${out}.json`, `${JSON.stringify({ date, url, n, seeds: trials.map((trial) => trial.seed), headline: report.headline, table: report.table, trials }, null, "\t")}\n`);
	writeFileSync(`${out}.md`, renderMarkdown(trials, { date, source: url }));
	console.log(`\nseed ${seed} done. ${report.headline}\n`);
}
console.log(`Wrote ${out}.json and ${out}.md`);
