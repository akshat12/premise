// Read-only APIs for the UI. No admin token: they expose nothing that the event stream does not.
import type { CommitSha, TaskDef } from "../../shared/types";
import { landing } from "../gate/client";
import { currentTrunk, hub } from "../hub/publish";
import { intentStub } from "../intent/client";
import { snapshotAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";
import { intentDiff } from "./diff";
import { isKnownIntent, parseIntentPath } from "./intent-id";
import { cachedJson, Memo, PUBLIC_MAX_AGE_S } from "./memo";

// These routes are public, and reading a repo is the expensive thing they do. So trunk's head is
// asked for at most once every few seconds, and what is read at a commit is read once.
const trunkHeads = new Memo<CommitSha>(PUBLIC_MAX_AGE_S * 1000, 8);
const taskLists = new Memo<TaskDef[]>(Number.POSITIVE_INFINITY, 8);

/** The repo acting as trunk and its head commit, which may be up to PUBLIC_MAX_AGE_S seconds old. */
async function trunkNow(env: Env): Promise<{ repo: string; head: CommitSha }> {
	const repo = await currentTrunk(env);
	return { repo, head: await trunkHeads.get(repo, () => getRepoStore(env).head(repo)) };
}

/** The task list as it is on trunk. Read once for each trunk commit. */
async function tasksNow(env: Env): Promise<TaskDef[]> {
	const { repo, head } = await trunkNow(env);
	return taskLists.get(`${repo}@${head}`, async () => {
		const text = await getRepoStore(env).readFile(repo, head, "premise/tasks.json");
		return text === null ? [] : (JSON.parse(text) as TaskDef[]);
	});
}

const noIntent = () => Response.json({ error: "no such Intent" }, { status: 404 });

/** GET /api/intents/:id and GET /api/intents/:id/diff. Nothing is opened for an id that is not a known Intent's. */
async function handleIntent(env: Env, id: string, rest: string): Promise<Response> {
	if ((rest !== "" && rest !== "diff") || !(await isKnownIntent(env, id))) {
		return noIntent();
	}
	const api = intentStub(env, id);
	const intent = await api.get().catch(() => null);
	if (intent === null) {
		return noIntent();
	}
	if (rest === "") {
		return Response.json(intent);
	}
	const diff = await intentDiff(intent, getRepoStore(env), () => api.overlay());
	// Pushed work is fixed by its two commits. Staged edits change as the agent works, and a fork that could not be read may be back.
	return diff.head === null ? Response.json(diff, { headers: { "Cache-Control": "no-store" } }) : cachedJson(diff);
}

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (request.method !== "GET") {
		return null;
	}
	const path = url.pathname;
	if (path === "/api/tasks") {
		return cachedJson(await tasksNow(env));
	}
	if (path === "/api/intents") {
		return Response.json(await hub(env).registry());
	}
	const intentPath = parseIntentPath(path);
	if (intentPath !== null) {
		return handleIntent(env, intentPath.id, intentPath.rest);
	}
	if (path === "/api/ledger") {
		return Response.json(await snapshotAcrossShards(env, await hub(env).shards()));
	}
	if (path === "/api/gate") {
		return Response.json(await landing(env).status());
	}
	if (path === "/api/metrics") {
		return Response.json(await hub(env).metrics());
	}
	if (path === "/api/trunk") {
		return cachedJson(await trunkNow(env));
	}
	return null;
}
