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

if (flag("replay")) {
	open(`${url}/?demo=main`);
} else {
	const api = worker(url);
	try {
		await api.get("/api/tasks");
	} catch {
		throw new Error(`Nothing answered at ${url}. Start it with \`npm run dev:local\` (or \`npm run dev\`), or pass --url <your deployed Worker>.`);
	}
	const reset = await api.post<{ trunk: string }>("/api/admin/reset-demo");
	console.log(`Reset. Trunk is ${reset.trunk}.`);
	open(`${url}/?live`);
	const tasks = await api.get<TaskDef[]>("/api/tasks");
	await api.post("/api/dispatch", { taskIds: tasks.map((task) => task.id), landFirst: ["t01-null-expired"] });
	console.log(`Dispatched ${tasks.length} tasks. T01 lands first, and breaks what T02, T03 and T11 rely on.`);
	if (workload > 0) {
		await api.post("/api/admin/workload", { n: workload, seed });
		console.log(`Started ${workload} scripted workload Intents (seed ${seed}).`);
	}
	console.log("The board is live. Press ⌘K on the page for commands, ? for keys.");
}
