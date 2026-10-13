// Runs the demo on a Worker and opens it in the browser.
//
//   npm run demo                                  # the Worker from `npm run dev` (http://localhost:5173)
//   npm run demo -- --url https://premise.<account>.workers.dev
//   npm run demo -- --replay                      # no backend work: plays the recorded run, /?demo=main
//
// Options: [--workload 40] [--seed 7] [--no-open]
//
// A live demo resets the Worker's demo state, dispatches every task (the one that changes what
// verifySession does lands first, so the premise break happens while the others are in flight)
// and starts the scripted workload. Watch it on the page that opens.
import { spawn } from "node:child_process";
import type { TaskDef } from "../src/shared/types";
import { arg, flag, worker } from "./lib/admin";

const url = (arg("url") ?? process.env.URL ?? "http://localhost:5173").replace(/\/$/, "");
const workload = Number(arg("workload", "40"));
const seed = Number(arg("seed", "7"));

function open(page: string): void {
	console.log(`Open ${page}`);
	if (flag("no-open")) {
		return;
	}
	const [command, args] = process.platform === "darwin" ? ["open", [page]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", page]] : ["xdg-open", [page]];
	// No browser to open is not a reason to stop: the address is printed above.
	spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
}

const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** How long the local runtime is left alone after its first request before it is given a run. */
const SETTLE_MS = 8000;

/** Resets, dispatches every task, and starts the workload. */
async function start(api: ReturnType<typeof worker>, show: boolean): Promise<void> {
	const reset = await api.post<{ trunk: string }>("/api/admin/reset-demo");
	console.log(`Reset. Trunk is ${reset.trunk}.`);
	if (show) {
		// With the owner's tools under "More" (dispatching by hand, reset): whoever runs this script is the owner.
		open(`${url}/?live&admin`);
	}
	const tasks = await api.get<TaskDef[]>("/api/tasks");
	await api.post("/api/dispatch", { taskIds: tasks.map((task) => task.id), landFirst: ["t01-null-expired"] });
	console.log(`Dispatched ${tasks.length} tasks. T01 lands first, and breaks what T02, T03 and T11 rely on.`);
	if (workload > 0) {
		await api.post("/api/admin/workload", { n: workload, seed });
		console.log(`Started ${workload} scripted workload Intents (seed ${seed}).`);
	}
}

if (flag("replay")) {
	open(`${url}/?demo=main`);
} else {
	const api = worker(url);
	try {
		await api.get("/api/tasks");
	} catch (error) {
		// A refused connection is nothing there. An answer that is not Premise's is something else on that port.
		const answered = error instanceof Error && / answered \d{3}/.test(error.message);
		throw new Error(
			answered
				? `Something answered at ${url}, but it is not Premise's Worker. If \`npm run dev:local\` said the port was in use and chose another, pass it: npm run demo -- --url http://localhost:<port>`
				: `Nothing answered at ${url}. Start it with \`npm run dev:local\` (or \`npm run dev\`), or pass --url <your Worker>. If the dev server chose another port, pass that: --url http://localhost:<port>`,
		);
	}
	if (local) {
		// The local Workers runtime has been seen to crash when it is handed a full run in its first seconds.
		// The Worker says how long it has been awake; a young one is given a moment.
		const awake = Number((await fetch(`${url}/api/health`).catch(() => null))?.headers.get("x-premise-awake-ms") ?? Number.NaN);
		if (!(awake >= SETTLE_MS)) {
			console.log("The local runtime has only just started. Giving it a few seconds to settle.");
			await pause(SETTLE_MS - (Number.isFinite(awake) ? awake : 0));
		}
	}
	try {
		await start(api, true);
	} catch (error) {
		if (!local) {
			throw error;
		}
		// The local Workers runtime sometimes restarts if it is given a run in its first few seconds, and a
		// restart empties its in-memory repos. So the whole start is done once more, after a moment.
		console.log(`The local runtime did not take that (${error instanceof Error ? error.message.split("\n")[0]?.slice(0, 120) : String(error)}). It can restart in its first seconds. Trying once more.`);
		await pause(8000);
		for (let waited = 0; waited < 30; waited++) {
			if (await api.get("/api/tasks").then(() => true, () => false)) {
				break;
			}
			await pause(1000);
		}
		await start(api, false);
	}
	console.log(`The board is live at ${url}/?live. Locally the run takes about fifteen seconds; it is over when the twelve agents' rows say "landed".`);
	console.log("Press ⌘K on the page for commands, ? for keys.");
}
