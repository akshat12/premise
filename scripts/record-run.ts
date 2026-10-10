// Records one real run of a deployed (or local) Worker, for the demo and the video.
//
//   npx tsx scripts/record-run.ts --url https://premise.<account>.workers.dev --out demo/runs/main.json
//       [--workload 300] [--seed 7] [--land-first t01-null-expired] [--timeout-minutes 30] [--attach]
//
// It resets the demo, dispatches every task and the scripted workload, waits until nothing is
// moving, and saves the whole event log. If the agents ran on a real model, their turns are saved
// next to it (demo/scripts/<name>.json) so the same run can be replayed later with no model.
// Then cut the idle time out with scripts/compress-run.ts and open /?demo=<name>.
//
// Do not run it while a demo you care about is on screen: the first thing it does is reset.
// With --attach it resets and dispatches nothing: it waits for the run already in progress and saves that.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PremiseEvent } from "../src/shared/events";
import type { TaskDef } from "../src/shared/types";
import { arg, flag, worker } from "./lib/admin";

const url = arg("url") ?? process.env.URL ?? "";
const out = arg("out");
if (!url || !out) {
	throw new Error("Usage: npx tsx scripts/record-run.ts --url <worker url> --out demo/runs/<name>.json [--workload 300] [--seed 7]");
}
const workload = Number(arg("workload", "300"));
const seed = Number(arg("seed", "7"));
// The task that changes what verifySession does lands first, while the others are in flight:
// that is what breaks their premises on camera. Pass --land-first "" to let landings fall as they may.
const landFirst = (arg("land-first", "t01-null-expired") ?? "").split(",").filter(Boolean);
const timeoutMs = Number(arg("timeout-minutes", "30")) * 60_000;
const POLL_MS = 3000;
/** Nothing moving on this many checks in a row counts as finished (workload Intents are still being created early on). */
const QUIET_CHECKS = 3;
const SETTLED = new Set(["landed", "failed", "escalated", "quarantined"]);

const api = worker(url);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GateStatus {
	queue: unknown[];
	busy: boolean;
	stale: unknown[];
	rederiving: unknown[];
}

async function allEvents(): Promise<PremiseEvent[]> {
	const events: PremiseEvent[] = [];
	for (let since = 0; ; ) {
		const page = await api.get<PremiseEvent[]>(`/api/events?since=${since}&limit=2000`);
		events.push(...page);
		const last = page.at(-1);
		if (last === undefined || page.length < 2000) {
			return events;
		}
		since = last.seq;
	}
}

const started = Date.now();
if (flag("attach")) {
	// A run is already going (this script was interrupted, or the run was started from the UI):
	// do not reset or dispatch, just wait for it and save it.
	console.log("Attaching to the run in progress.");
} else {
	const reset = await api.post<{ trunk: string }>("/api/admin/reset-demo");
	console.log(`Reset. Trunk is ${reset.trunk}.`);

	const tasks = await api.get<TaskDef[]>("/api/tasks");
	const taskIds = tasks.map((task) => task.id);
	await api.post("/api/dispatch", { taskIds, ...(landFirst.length > 0 ? { landFirst } : {}) });
	console.log(`Dispatched ${taskIds.length} tasks${landFirst.length > 0 ? ` (landing ${landFirst.join(", ")} first)` : ""}.`);
	if (workload > 0) {
		await api.post("/api/admin/workload", { n: workload, seed });
		console.log(`Started ${workload} scripted workload Intents (seed ${seed}).`);
	}
}

for (let quiet = 0; quiet < QUIET_CHECKS; ) {
	await sleep(POLL_MS);
	if (Date.now() - started > timeoutMs) {
		throw new Error(`The run was still moving after ${timeoutMs / 60_000} minutes. Nothing was saved.`);
	}
	const [gate, registry] = await Promise.all([api.get<GateStatus>("/api/gate"), api.get<{ status: string }[]>("/api/intents")]);
	const counts: Record<string, number> = {};
	for (const row of registry) {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
	}
	const moving = registry.some((row) => !SETTLED.has(row.status)) || gate.queue.length > 0 || gate.busy || gate.stale.length > 0 || gate.rederiving.length > 0;
	quiet = moving || registry.length === 0 ? 0 : quiet + 1;
	const summary = Object.entries(counts)
		.sort()
		.map(([status, count]) => `${status}=${count}`)
		.join(" ");
	console.log(`${Math.round((Date.now() - started) / 1000)}s ${summary}`);
}

const events = await allEvents();
mkdirSync(dirname(out), { recursive: true });
// One event to a line: the file diffs, and is no bigger than it has to be.
writeFileSync(out, `[\n${events.map((event) => JSON.stringify(event)).join(",\n")}\n]\n`);

const count = (type: PremiseEvent["t"]) => events.filter((event) => event.t === type).length;
const ends: Record<string, number> = {};
const latest = new Map<string, string>();
for (const event of events) {
	if (event.t === "intent.created") {
		latest.set(event.intent.id, event.intent.status);
	} else if (event.t === "intent.status") {
		latest.set(event.id, event.status);
	}
}
for (const status of latest.values()) {
	ends[status] = (ends[status] ?? 0) + 1;
}
const span = (events.at(-1)?.ts ?? 0) - (events[0]?.ts ?? 0);
console.log(`\nSaved ${events.length} events (${Math.round(span / 1000)} s of the run) to ${out}`);
console.log(`Intents: ${[...Object.entries(ends)].map(([status, n]) => `${n} ${status}`).join(", ")}`);
console.log(`Premises broken: ${count("premise.broken")}. Calls for a person: ${count("human.needed")}.`);
const waiting = (ends.escalated ?? 0) + (ends.quarantined ?? 0);
if (waiting > 0) {
	console.log(`${waiting} Intents are waiting for a person. The recording ends with them still waiting.`);
}

const turns = await api.post<{ llm: { provider: string; model?: string }; scripts: Record<string, unknown[]> }>("/api/admin/llm-turns");
const keys = Object.keys(turns.scripts);
if (keys.length === 0) {
	console.log(`The agents were ${turns.llm.provider === "scripted" ? "scripted" : `on ${turns.llm.provider}, but no turns were kept`}, so there are no model turns to save.`);
} else {
	const scriptsFile = join(dirname(dirname(out)), "scripts", basename(out));
	mkdirSync(dirname(scriptsFile), { recursive: true });
	writeFileSync(scriptsFile, `${JSON.stringify({ llm: turns.llm, scripts: turns.scripts }, null, "\t")}\n`);
	console.log(`Saved the model's turns for ${keys.length} scripts (${turns.llm.provider}${turns.llm.model ? `, ${turns.llm.model}` : ""}) to ${scriptsFile}`);
}
console.log(`\nNext: npx tsx scripts/compress-run.ts ${out}`);
