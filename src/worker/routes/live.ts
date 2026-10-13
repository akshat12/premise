// The run anyone can start: GET /api/live says whether one may, POST /api/live/start starts it.
// Neither takes a token, and the start takes no parameters, so there is nothing for a caller to
// choose. The limits are in live/public-run.ts and are applied by the hub.
import { hub } from "../hub/publish";
import type { PublicRunStatus } from "../live/public-run";
import { PUBLIC_RUN } from "../live/public-run";
import { gateBusy, type PublicRunParams, publicRunInstanceId } from "../live/start";
import { release } from "../ports/release";
import { Memo } from "./memo";

// The page asks every few seconds while the Live tab is open. One answer serves everyone for a moment.
const STATUS_TTL_MS = 2000;
const statuses = new Memo<PublicRunStatus>(STATUS_TTL_MS, 1);

/** Called when something this isolate did has changed the answer (the switch, a start), so the next GET asks afresh. */
export function forgetLiveStatus(): void {
	statuses.clear();
}

const noStore = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleLive(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (url.pathname === "/api/live") {
		if (request.method !== "GET") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		return noStore(await statuses.get("status", async () => hub(env).publicRun(await gateBusy(env))));
	}
	if (url.pathname !== "/api/live/start") {
		return null;
	}
	if (request.method !== "POST") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}
	// The body is not read: there is nothing in it this route would use.
	const busy = await gateBusy(env);
	const claim = await hub(env).claimPublicRun(busy);
	if (!claim.ok) {
		return noStore({ ok: false, reason: claim.status.reason, status: claim.status }, claim.status.reason === "running" || claim.status.reason === "cooldown" || claim.status.reason === "cap" ? 429 : 403);
	}
	// Only a start that was taken changes what the status route should say.
	forgetLiveStatus();
	const params: PublicRunParams = { mode: "public-run", startedAt: claim.startedAt, seed: claim.seed, workload: PUBLIC_RUN.workload };
	try {
		release(await env.AGENT_WORKFLOW.create({ id: publicRunInstanceId(claim.startedAt), params }));
	} catch (error) {
		// The start was taken and nothing will come of it. Say so, so the page does not wait for a run.
		const message = error instanceof Error ? error.message : String(error);
		console.error(`public run ${claim.startedAt} could not be handed to a Workflow: ${message}`);
		await hub(env).publicRunFailed(claim.startedAt, message);
		return noStore({ ok: false, reason: "failed", status: await hub(env).publicRun(busy) }, 502);
	}
	return noStore({ ok: true, startedAt: claim.startedAt, status: await hub(env).publicRun(busy) }, 202);
}
