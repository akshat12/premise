import { AgentWorkflow } from "./agent/workflow";
import { Landing } from "./gate/landing";
import { consumeBatch } from "./events/consumer";
import { EventHub } from "./hub/event-hub";
import { IntentDO } from "./intent/intent-do";
import { LedgerShard } from "./ledger/ledger-shard";
import { recoverMemoryStore } from "./dispatch";
import { healthBody } from "./health";
import { handleAdmin } from "./routes/admin";
import { handleApi } from "./routes/api";
import { handleDispatch } from "./routes/dispatch";
import { handleEvents } from "./routes/events";

// Memory mode: checked once each time this code is loaded, before the first request is answered.
// See recoverMemoryStore for what it is checking.
let memoryChecked: Promise<unknown> | undefined;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json(healthBody(env));
		}
		if (env.REPO_STORE === "memory" && url.pathname.startsWith("/api/")) {
			await (memoryChecked ??= recoverMemoryStore(env).catch((error: unknown) => {
				// Could not tell, or could not recover: let this request go on, and look again on the next.
				memoryChecked = undefined;
				console.error("memory store check failed", error);
			}));
		}
		if (url.pathname.startsWith("/api/admin/")) {
			return handleAdmin(request, env, url);
		}
		if (url.pathname === "/api/events" || url.pathname === "/api/events/ws") {
			return handleEvents(request, env, url);
		}
		if (url.pathname.startsWith("/api/")) {
			return (await handleDispatch(request, env, url)) ?? (await handleApi(request, env, url)) ?? Response.json({ error: "not found" }, { status: 404 });
		}
		// Everything else is the UI. Static assets are served before the Worker runs
		// (see `assets` in wrangler.jsonc), so reaching here means there was no match.
		return new Response("Not found", { status: 404 });
	},

	// Artifacts event subscriptions deliver here (see events/consumer.ts).
	async queue(batch, env): Promise<void> {
		await consumeBatch(batch, env);
	},
} satisfies ExportedHandler<Env>;

// Durable Objects and Workflows must be exported from the entry module.
export { AgentWorkflow, EventHub, IntentDO, Landing, LedgerShard };
