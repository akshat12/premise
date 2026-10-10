// Runs the A/B comparison against a deployed (or local) Worker and writes the report.
//
//   npx tsx scripts/ab.ts --url https://premise.<account>.workers.dev [--n 100] [--seed 7]
//
// The admin token is read from the ADMIN_TOKEN environment variable, or from .dev.vars.
// Each mode resets the demo first, so do not run this while a demo you care about is on screen.
import { readFileSync, writeFileSync } from "node:fs";
import { buildReport, type ModeResult, renderMarkdown } from "../src/worker/ab/report";

function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

function adminToken(): string {
	if (process.env.ADMIN_TOKEN) {
		return process.env.ADMIN_TOKEN;
	}
	try {
		const line = readFileSync(".dev.vars", "utf8").split("\n").find((candidate) => candidate.startsWith("ADMIN_TOKEN="));
		if (line) {
			return line.slice("ADMIN_TOKEN=".length).trim();
		}
	} catch {
		// fall through to the error below
	}
	throw new Error("Set ADMIN_TOKEN, or put it in .dev.vars");
}

const url = (arg("url") ?? process.env.URL ?? "").replace(/\/$/, "");
const n = Number(arg("n", "100"));
const seed = Number(arg("seed", "7"));
const timeoutMs = Number(arg("timeout-minutes", "40")) * 60_000;
if (!url) {
	throw new Error("Usage: npx tsx scripts/ab.ts --url <worker url> [--n 100] [--seed 7]");
}
const headers = { "x-admin-token": adminToken(), "content-type": "application/json" };

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
	if (!response.ok) {
		throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	return (await response.json()) as T;
}

async function runMode(mode: "baseline" | "premise"): Promise<ModeResult> {
	const started = Date.now();
	await post("/api/admin/ab", { mode, n, seed });
	console.log(`${mode}: started (${n} workload Intents, seed ${seed})`);
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const state = await post<{ quiet: boolean; counts: Record<string, number>; result?: ModeResult }>("/api/admin/ab/result", { mode, n, seed });
		const summary = Object.entries(state.counts).sort().map(([status, count]) => `${status}=${count}`).join(" ");
		console.log(`${mode}: ${Math.round((Date.now() - started) / 1000)}s ${summary}`);
		if (state.quiet && state.result) {
			return state.result;
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`${mode} did not go quiet within ${timeoutMs / 60_000} minutes`);
		}
	}
}

const baseline = await runMode("baseline");
const premise = await runMode("premise");
const report = buildReport(baseline, premise);
const date = new Date().toISOString().slice(0, 10);
writeFileSync("docs/ab-results.json", `${JSON.stringify({ date, url, n, seed, headline: report.headline, table: report.table, baseline, premise }, null, "\t")}\n`);
writeFileSync("docs/ab-results.md", renderMarkdown(baseline, premise, { date, source: url }));
console.log(`\n${report.headline}\nWrote docs/ab-results.json and docs/ab-results.md`);
