import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { EventHub } from "./hub/event-hub";
import { healthBody } from "./health";
import { handleAdmin } from "./routes/admin";
import { handleEvents } from "./routes/events";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json(healthBody(env));
		}
		if (url.pathname.startsWith("/api/admin/")) {
			return handleAdmin(request, env, url);
		}
		if (url.pathname === "/api/events" || url.pathname === "/api/events/ws") {
			return handleEvents(request, env, url);
		}
		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
		// Everything else is the UI. Static assets are served before the Worker runs
		// (see `assets` in wrangler.jsonc), so reaching here means there was no match.
		return new Response("Not found", { status: 404 });
	},

	// Stub: Artifacts event subscriptions arrive here. T16 gives this real logic.
	async queue(batch): Promise<void> {
		for (const message of batch.messages) {
			console.log("queue message", batch.queue, message.id);
			message.ack();
		}
	},
} satisfies ExportedHandler<Env>;

// Durable Objects and Workflows must be exported from the entry module.
// The classes below are still stubs; each gets its logic in a later task.

export { EventHub };

/** One Intent: state machine and premise store (T10). */
export class IntentDO extends DurableObject<Env> {}

/** Claims and premise subscriptions for one module directory (T08). */
export class LedgerShard extends DurableObject<Env> {}

/** The gate: serialises landings onto trunk (T15). */
export class Landing extends DurableObject<Env> {}

/** Drives one agent through plan, claim, work and submit (T11). */
export class AgentWorkflow extends WorkflowEntrypoint<Env, unknown> {
	async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<string> {
		return step.do("stub", async () => "ok");
	}
}
