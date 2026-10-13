import { isEventBody } from "../../shared/wire";
import { isAdminRequest } from "../admin-auth";
import { deleteRun, resetDemo } from "../dispatch";
import { currentTrunk, hub, publish, withChosenLlm } from "../hub/publish";
import { getRepoStore } from "../ports";
import { ArtifactsRepoStore } from "../ports/artifacts-repo-store";
import { runContract } from "../ports/repo-store.contract";
import { describeLlm, resolveLlmConfig } from "../ports/llm";
import { runInIsolate } from "../runner";
import { analyze } from "../surface";
import type { Assertion } from "../../shared/types";
import { importTrunk } from "./import-trunk";
import { gateBusy } from "../live/start";
import { forgetLiveStatus, forgetRunLandings } from "./live";
import { MAX_WORKLOAD, runWorkload } from "../workload/run";
import { type AbOptions, collectAb, isQuiet, runAbMode, startAbMode } from "../ab/run";

const SMOKE_PREFIX = "smoke";

function abOptions(body: Record<string, unknown>): AbOptions | null {
	const n = body.n === undefined ? 100 : body.n;
	const seed = body.seed === undefined ? 7 : body.seed;
	if ((body.mode !== "baseline" && body.mode !== "queue" && body.mode !== "premise") || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_WORKLOAD || typeof seed !== "number" || !Number.isFinite(seed)) {
		return null;
	}
	return { mode: body.mode, n, seed };
}

/** Deletes any `smoke-*` repos a crashed run left behind. */
async function sweepSmokeRepos(artifacts: Artifacts): Promise<string[]> {
	const deleted: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await artifacts.list({ limit: 100, cursor });
		for (const repo of page.repos) {
			if (repo.name.startsWith(`${SMOKE_PREFIX}-`) && (await artifacts.delete(repo.name))) {
				deleted.push(repo.name);
			}
		}
		cursor = page.cursor;
	} while (cursor);
	return deleted;
}

/** Runs the RepoStore contract against real Artifacts, whatever REPO_STORE is set to. */
async function smoke(env: Env): Promise<Response> {
	const start = Date.now();
	const results = await runContract(() => new ArtifactsRepoStore(env), { prefix: SMOKE_PREFIX, parallel: true });
	const swept = await sweepSmokeRepos(env.ARTIFACTS);
	const ok = results.every((result) => result.ok);
	return Response.json({ ok, ms: Date.now() - start, results, swept }, { status: ok ? 200 : 500 });
}

/** Routes under /api/admin/. Every one requires the `x-admin-token` header. */
export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
	if (!isAdminRequest(request, env)) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	if (request.method !== "POST") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}
	const removed = /^\/api\/admin\/runs\/([1-9]\d{0,8})\/delete$/.exec(url.pathname);
	if (removed !== null) {
		// Takes one kept run out of the record of runs. The run on the board is not a kept run: a reset clears that.
		const result = await deleteRun(env, Number(removed[1]));
		forgetRunLandings();
		return result === null ? Response.json({ error: "no such run" }, { status: 404 }) : Response.json({ ok: true, ...result });
	}
	switch (url.pathname) {
		case "/api/admin/smoke":
			return smoke(env);
		case "/api/admin/analyze": {
			// A health check of the two things that run repo code inside this Worker: the TypeScript
			// compiler (typecheck and symbol surfaces) and the Dynamic Worker runner (tests and assertions).
			const files = await getRepoStore(env).snapshot(await currentTrunk(env), "main");
			const result = analyze(files);
			const assertions = JSON.parse(files["premise/assertions.json"] ?? "[]") as Assertion[];
			const testFile = "tests/session.test.ts";
			const tests = [...(files[testFile] ?? "").matchAll(/^\t"([^"]+)": (?:async )?\(\) =>/gm)].map((match) => ({ file: testFile, name: match[1] ?? "" }));
			const run = await runInIsolate(env, { files, tests, assertions });
			return Response.json({
				ok: result.typecheck.ok && run.loadError === undefined,
				errors: result.typecheck.errors.slice(0, 20),
				files: Object.keys(files).length,
				symbols: result.surface.size,
				verifySession: result.surface.get("src/auth/session.ts#verifySession") ?? null,
				ms: result.ms,
				runner: {
					loadError: run.loadError ?? null,
					testsPassed: run.tests.filter((test) => test.ok).length,
					testsFailed: run.tests.filter((test) => !test.ok),
					assertions: run.assertions,
				},
			});
		}
		case "/api/admin/workload": {
			// Starts `n` scripted workload Intents. They are labelled `kind: "workload"` everywhere.
			const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
			const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
			const n = number(body.n);
			if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_WORKLOAD) {
				return Response.json({ error: `body must be { n: 1..${MAX_WORKLOAD}, seed?: number, concurrency?: number, overlapRate?: number }` }, { status: 400 });
			}
			const concurrency = number(body.concurrency);
			const overlapRate = number(body.overlapRate);
			const summary = await runWorkload(env, { n, seed: number(body.seed) ?? 1, ...(concurrency === undefined ? {} : { concurrency }), ...(overlapRate === undefined ? {} : { overlapRate }) });
			return Response.json({ ok: true, ...summary });
		}
		case "/api/admin/ab": {
			// Starts one mode of the A/B comparison (it resets the demo first). With `wait`, also waits for it and returns the measurements.
			const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
			const options = abOptions(body);
			if (options === null) {
				return Response.json({ error: 'body must be { mode: "baseline" | "queue" | "premise", n?: 0..1000, seed?: number, wait?: boolean }' }, { status: 400 });
			}
			return Response.json(body.wait === true ? { ok: true, result: await runAbMode(env, options) } : { ok: true, ...(await startAbMode(env, options)) });
		}
		case "/api/admin/ab/result": {
			// The measurements for the mode that was started, once nothing is moving any more.
			const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
			const options = abOptions(body);
			if (options === null) {
				return Response.json({ error: 'body must be { mode: "baseline" | "queue" | "premise", n?: number, seed?: number }' }, { status: 400 });
			}
			const state = await isQuiet(env);
			return Response.json(state.quiet ? { ok: true, quiet: true, counts: state.counts, result: await collectAb(env, options) } : { ok: true, quiet: false, counts: state.counts });
		}
		case "/api/admin/llm": {
			// Chooses which model provider the agents use from now on, without a redeploy:
			// { provider: "scripted" } replays recorded agents; { provider: "google", model: "..." } uses a real model.
			// { provider: null } goes back to what the Worker is configured with.
			const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
			if (body.provider === null) {
				await hub(env).setLlm(null);
				forgetLiveStatus();
				return Response.json({ ok: true, llm: describeLlm(env) });
			}
			if (typeof body.provider !== "string" || (body.model !== undefined && typeof body.model !== "string")) {
				return Response.json({ error: "body must be { provider: string | null, model?: string }" }, { status: 400 });
			}
			const choice = { provider: body.provider, ...(typeof body.model === "string" ? { model: body.model } : {}) };
			const chosen = { ...env, LLM: choice.provider, ...(choice.model === undefined ? {} : { LLM_MODEL: choice.model }) };
			let provider: string;
			try {
				provider = resolveLlmConfig(chosen).provider; // refuses an unknown provider, or one whose key is not set
			} catch (error) {
				return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
			}
			if (provider !== "scripted") {
				// Each agent reads this choice when it starts, and a re-derive is a new start. Changed in the middle of a
				// run, the rest of that run would call the model, and the run may be one a visitor started from the Live tab.
				const board = await hub(env).publicRun(await gateBusy(env));
				if (board.running && !board.starting) {
					return Response.json({ error: "a run is in progress, and the rest of it would switch to the model. Wait for it to end, or reset the demo first." }, { status: 409 });
				}
			}
			await hub(env).setLlm(choice);
			forgetLiveStatus();
			return Response.json({ ok: true, llm: describeLlm(chosen) });
		}
		case "/api/admin/public-runs": {
			// The switch for the run anyone can start from the Live tab: { enabled: false } refuses every start until it is turned on again.
			const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
			// { clear: true } also forgets the starts on record: the day's runs are given back and the wait between runs ends.
			if (typeof body.enabled !== "boolean" || (body.clear !== undefined && typeof body.clear !== "boolean")) {
				return Response.json({ error: "body must be { enabled: boolean, clear?: boolean }" }, { status: 400 });
			}
			await hub(env).setPublicRuns(body.enabled, body.clear === true);
			forgetLiveStatus();
			return Response.json({ ok: true, enabled: body.enabled, cleared: body.clear === true });
		}
		case "/api/admin/llm-turns":
			// What a real model answered since the last reset, as scripts the scripted provider can replay.
			// Empty when the agents were scripted: there is nothing to record.
			return Response.json({ ok: true, llm: describeLlm(await withChosenLlm(env)), scripts: await hub(env).recordedTurns() });
		case "/api/admin/import-trunk":
			return importTrunk(request, env);
		case "/api/admin/reset-demo":
			return Response.json({ ok: true, ...(await resetDemo(env)) });
		case "/api/admin/events/reset":
			await hub(env).reset();
			return Response.json({ ok: true });
		case "/api/admin/events/fake": {
			// Publishes whatever event body is posted. For UI testing.
			const body: unknown = await request.json().catch(() => null);
			if (!isEventBody(body)) {
				return Response.json({ error: "body must be a PremiseEventBody with a known `t`" }, { status: 400 });
			}
			return Response.json(await publish(env, body));
		}
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
