// Read-only APIs for the UI. No admin token: they expose nothing that the event stream does not.
import { loadTasks } from "../dispatch";
import { currentTrunk, hub } from "../hub/publish";
import { intentStub } from "../intent/client";
import { snapshotAcrossShards } from "../ledger/client";
import { getRepoStore } from "../ports";

export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (request.method !== "GET") {
		return null;
	}
	const path = url.pathname;
	if (path === "/api/tasks") {
		return Response.json(await loadTasks(env));
	}
	if (path === "/api/intents") {
		return Response.json(await hub(env).registry());
	}
	if (path.startsWith("/api/intents/")) {
		const id = decodeURIComponent(path.slice("/api/intents/".length));
		try {
			return Response.json(await intentStub(env, id).get());
		} catch {
			return Response.json({ error: `no Intent ${id}` }, { status: 404 });
		}
	}
	if (path === "/api/ledger") {
		return Response.json(await snapshotAcrossShards(env, await hub(env).shards()));
	}
	if (path === "/api/metrics") {
		return Response.json(await hub(env).metrics());
	}
	if (path === "/api/trunk") {
		const trunk = await currentTrunk(env);
		return Response.json({ repo: trunk, head: await getRepoStore(env).head(trunk) });
	}
	return null;
}
