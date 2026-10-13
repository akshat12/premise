// What a public run does once it has been allowed (see public-run.ts for whether it is): the same
// three things `npm run demo` does, with nothing chosen by the caller.
import { AB_LAND_FIRST } from "../ab/run";
import { DispatchFailed, dispatchTasks, loadTasks, resetDemo } from "../dispatch";
import { landing } from "../gate/client";
import { hub, withChosenLlm } from "../hub/publish";
import { resolveLlmConfig } from "../ports/llm";
import { runWorkload, type Spawn } from "../workload/run";

export interface PublicRunParams {
	mode: "public-run";
	/** When the start was claimed. It names the run in the hub's record. */
	startedAt: number;
	seed: number;
	workload: number;
}

export const isPublicRunParams = (params: unknown): params is PublicRunParams => typeof params === "object" && params !== null && (params as { mode?: unknown }).mode === "public-run";

/** The Workflow instance for the run claimed at `startedAt`. */
export const publicRunInstanceId = (startedAt: number): string => `public-run-${startedAt}`;

export type PublicRunResult = { ok: true; agents: number; workload: number } | { ok: false; error: string };

/** The one thing about the board that only the gate knows: whether it still has work in hand. */
export async function gateBusy(env: Pick<Env, "LANDING">): Promise<boolean> {
	const status = await landing(env).status();
	return status.busy || status.queue.length > 0 || status.stale.length > 0 || status.rederiving.length > 0;
}

/** Runs one named part of the start. A Workflow makes each one durable and never repeats it; a test just calls it. */
export type Once = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/**
 * Resets, dispatches every task in the demo repo, and starts the scripted workload. None of the
 * three is safe to do twice, so none is retried: a start that fails is recorded as failed and the
 * next one begins from a reset anyway.
 */
export async function runPublicRun(env: Env, params: PublicRunParams, once: Once, deps: { spawn?: Spawn } = {}): Promise<PublicRunResult> {
	let agents: number;
	try {
		await once("reset", async () => {
			// Everything the claim was allowed on is asked again here, at the moment the board is about to be
			// cleared: the claim may be a second old or, if the platform was slow, much older. The switch, the
			// provider, and whether somebody else has reset or started a run in between.
			const refusal = await hub(env).confirmPublicRun(params.startedAt, await gateBusy(env));
			if (refusal !== null) {
				throw new Error(refusal);
			}
			// And the provider once more from the configuration itself: a public run never calls a model.
			if (resolveLlmConfig(await withChosenLlm(env)).provider !== "scripted") {
				throw new Error("the agents are set to use a model; public runs are scripted only");
			}
			await resetDemo(env, { origin: "visitor" });
			return true;
		});
		agents = await once("dispatch", async () => {
			const tasks = (await loadTasks(env)).map((task) => task.id);
			try {
				return (await dispatchTasks(env, tasks, undefined, undefined, { landFirst: AB_LAND_FIRST })).length;
			} catch (error) {
				// Some agents starting is still a run. None starting is not.
				if (error instanceof DispatchFailed && error.started.length > 0) {
					return error.started.length;
				}
				throw error;
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The reason is for whoever runs the Worker: the public status only says that the start failed.
		console.error(`public run ${params.startedAt} did not start: ${message}`);
		await once("failed", async () => {
			await hub(env).publicRunFailed(params.startedAt, message);
			return true;
		});
		return { ok: false, error: message };
	}
	// The agents are running by now. A workload that cannot start leaves a smaller run, not a failed one.
	const workload = params.workload > 0 ? await once("workload", async () => (await runWorkload(env, { n: params.workload, seed: params.seed }, deps.spawn ? { spawn: deps.spawn } : {})).started).catch(() => 0) : 0;
	return { ok: true, agents, workload };
}
