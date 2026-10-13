// Runs the demo on a Worker and opens it in the browser.
//
//   npm run demo                                  # the Worker from `npm run dev` (http://localhost:5173)
//   npm run demo -- --url https://premise.<account>.workers.dev
//   npm run demo -- --replay                      # no backend work: plays the recorded run, /?demo=main
//
// Options: [--workload 40] [--seed 7] [--agents 12] [--tasks t05-tax-rounding,t06-discount-stacking] [--no-open]
//
// --agents 5 dispatches five of the tasks, not all of them: the four the premise break is about
// first (the one that changes verifySession, and the three that rely on it), then the rest in order.
// --tasks names the tasks to dispatch, for a run about something else (t05 and t06 both want
// computeTotal, which is the ledger's case, not a broken premise).
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
const named = arg("tasks")?.split(",").map((id) => id.trim()).filter((id) => id !== "") ?? null;
const agents = arg("agents") === undefined ? null : Number(arg("agents"));
/** The tasks the premise break is about: T01 changes what verifySession does, and these three rely on it. */
const STORY = ["t01-null-expired", "t02-audit-expired", "t03-expired-metrics", "t11-expired-rate-limit"];

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
	const every = (await api.get<TaskDef[]>("/api/tasks")).map((task) => task.id);
	// Fewer agents than tasks: the story's four first, then the others, and dispatched in the repo's own order.
	const unknown = (named ?? []).filter((id) => !every.includes(id));
	if (unknown.length > 0) {
		throw new Error(`No such task: ${unknown.join(", ")}. The tasks are ${every.join(", ")}.`);
	}
	const wanted = named !== null ? named : agents === null ? every : [...STORY.filter((id) => every.includes(id)), ...every.filter((id) => !STORY.includes(id))].slice(0, agents);
	const taskIds = every.filter((id) => wanted.includes(id));
	const story = taskIds.includes("t01-null-expired");
	await api.post("/api/dispatch", { taskIds, ...(story ? { landFirst: ["t01-null-expired"] } : {}) });
	console.log(`Dispatched ${taskIds.length} of ${every.length} tasks.${story ? " T01 lands first, and breaks what T02, T03 and T11 rely on." : ""}`);
	if (workload > 0) {
		await api.post("/api/admin/workload", { n: workload, seed });
		console.log(`Started ${workload} scripted workload Intents (seed ${seed}).`);
	}
}

if (flag("replay")) {
	open(`${url}/?demo=main`);
} else {
	if (agents !== null && !(Number.isInteger(agents) && agents >= 1)) {
		throw new Error("--agents takes a whole number, 1 or more");
	}
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
	console.log(`The board is live at ${url}/?live. Locally the run takes about fifteen seconds; it is over when every agent's row says "landed".`);
	console.log("Press ⌘K on the page for commands, ? for keys.");
}
