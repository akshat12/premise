// The run anyone can start: GET /api/live says whether one may, POST /api/live/start starts it.
// Neither takes a token, and the start takes no parameters, so there is nothing for a caller to
// choose. The limits are in live/public-run.ts and are applied by the hub.
import { parseSince } from "../../shared/wire";
import { unavailableDiff } from "../diff/intent-diff";
import { hub } from "../hub/publish";
import type { PublicRunStatus } from "../live/public-run";
import { PUBLIC_RUN } from "../live/public-run";
import { gateBusy, type PublicRunParams, publicRunInstanceId } from "../live/start";
import { getRepoStore } from "../ports";
import { release } from "../ports/release";
import { landedDiff } from "./diff";
import { cachedJson, Memo } from "./memo";

// The page asks every few seconds while the Live tab is open. One answer serves everyone for a moment.
const STATUS_TTL_MS = 2000;
const statuses = new Memo<PublicRunStatus>(STATUS_TTL_MS, 1);

// Where an Intent landed in a past run. A kept run does not change; a few minutes covers one that is not kept yet.
const landings = new Memo<Awaited<ReturnType<ReturnType<typeof hub>["runLanding"]>>>(5 * 60_000, 256);

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
	if (url.pathname === "/api/runs") {
		// The run on the board and the ones before it, a line each. Read-only, and the same for everyone for a few seconds.
		return request.method === "GET" ? cachedJson(await hub(env).runs()) : Response.json({ error: "method not allowed" }, { status: 405 });
	}
	const kept = /^\/api\/runs\/([1-9]\d{0,8})\/events$/.exec(url.pathname);
	if (kept !== null) {
		// The log of a past run, to play it again. It never changes, so it may be kept by whoever asks.
		if (request.method !== "GET") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		const requested = Number(url.searchParams.get("limit") ?? 5000);
		const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 5000) : 5000;
		const events = await hub(env).runEvents(Number(kept[1]), parseSince(url), limit);
		return events.length === 0 && parseSince(url) === 0 ? Response.json({ error: "no such run, or its events were not kept" }, { status: 404 }) : cachedJson(events, 3600);
	}
	const changed = /^\/api\/runs\/([1-9]\d{0,8})\/intents\/([0-9a-z-]{1,40})\/diff$/.exec(url.pathname);
	if (changed !== null) {
		// What an Intent changed in a past run, as it landed. Its fork is gone; the run's trunk is kept.
		if (request.method !== "GET") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		const intentId = changed[2] as string;
		// Asked of the hub once per run and Intent: finding it reads the whole of the run's log there.
		const found = await landings.get(`${changed[1]}:${intentId}`, () => hub(env).runLanding(Number(changed[1]), intentId));
		if (found === null) {
			return Response.json({ error: "no such run" }, { status: 404 });
		}
		if (found.landing === null) {
			return Response.json({ error: "that Intent did not land in this run, so its changes were not kept" }, { status: 404 });
		}
		const diff = found.trunk === null ? unavailableDiff(intentId, found.landing.parent, found.landing.commit) : await landedDiff(intentId, found.trunk, found.landing, getRepoStore(env));
		// A landing is two commits and never changes. A trunk that could not be read may only be slow, so that answer is not kept.
		return diff.unavailable ? noStore(diff) : cachedJson(found.landing.together > 1 ? { ...diff, together: found.landing.together } : diff, 3600);
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
