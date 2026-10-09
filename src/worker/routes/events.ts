import { parseSince } from "../../shared/wire";
import { hub } from "../hub/publish";

const MAX_LIMIT = 5000;

/** GET /api/events/ws (WebSocket) and GET /api/events (JSON). Read-only, so no admin token. */
export async function handleEvents(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method !== "GET") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}
	if (url.pathname === "/api/events/ws") {
		return hub(env).fetch(request);
	}
	if (url.pathname === "/api/events") {
		const requested = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
		const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : MAX_LIMIT;
		return Response.json(await hub(env).since(parseSince(url), limit));
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
