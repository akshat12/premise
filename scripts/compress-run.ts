// Cuts the idle time out of a recorded run and marks every cut, so the demo is short and honest.
//
//   npx tsx scripts/compress-run.ts demo/runs/main.json [--max-gap 4] [--keep 1]
//
// Wherever nothing happened for more than --max-gap seconds, the gap is cut to about --keep
// seconds and a `demo.marker` event ("⏩ 2m 10s compressed") is put there. The file is rewritten
// in place; the untouched recording is kept once in demo/raw/. Running it again changes nothing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PremiseEvent } from "../src/shared/events";
import { compressRun, KEPT_GAP_MS, MAX_GAP_MS } from "../src/ui/lib/demo";
import { arg } from "./lib/admin";

const file = process.argv[2];
if (!file || file.startsWith("--")) {
	throw new Error("Usage: npx tsx scripts/compress-run.ts demo/runs/<name>.json [--max-gap 4] [--keep 1]");
}
const maxGapMs = Number(arg("max-gap", String(MAX_GAP_MS / 1000))) * 1000;
const keptMs = Number(arg("keep", String(KEPT_GAP_MS / 1000))) * 1000;

const text = readFileSync(file, "utf8");
const events = JSON.parse(text) as PremiseEvent[];
const { events: compressed, cuts, cutMs } = compressRun(events, maxGapMs, keptMs);

const seconds = (ms: number) => `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
const length = (log: readonly PremiseEvent[]) => (log.at(-1)?.ts ?? 0) - (log[0]?.ts ?? 0);
if (cuts === 0) {
	console.log(`${file}: nothing to cut (no stretch longer than ${maxGapMs / 1000} s without an event). It plays in ${seconds(length(events))}.`);
} else {
	const raw = join(dirname(dirname(file)), "raw", basename(file));
	if (!existsSync(raw)) {
		mkdirSync(dirname(raw), { recursive: true });
		writeFileSync(raw, text);
	}
	writeFileSync(file, `[\n${compressed.map((event) => JSON.stringify(event)).join(",\n")}\n]\n`);
	console.log(`${file}: cut ${cuts} idle ${cuts === 1 ? "stretch" : "stretches"}, ${seconds(cutMs)} in all. It now plays in ${seconds(length(compressed))} at 1× (was ${seconds(length(events))}).`);
	console.log(`The untouched recording is in ${raw}.`);
}
