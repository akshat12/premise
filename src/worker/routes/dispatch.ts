// The two things a person does: dispatch work, and settle an escalated Intent. Both need the admin token.
import type { TaskId } from "../../shared/types";
import { isAdminRequest } from "../admin-auth";
import { wakeHumanWaiters } from "../agent/wake";
import { DispatchFailed, dispatchTasks, UnknownTasks } from "../dispatch";
import { settleQuarantine } from "../gate/checker";
import { gateEnqueue, landing } from "../gate/client";
import { intentStub } from "../intent/client";
import { publish } from "../hub/publish";

export const HUMAN_CHOICES = ["Wait", "Split", "Depend", "Retry", "Abandon"] as const;

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export async function handleDispatch(request: Request, env: Env, url: URL): Promise<Response | null> {
	const isDispatch = url.pathname === "/api/dispatch";
	const isHuman = url.pathname.startsWith("/api/human/");
	if (!isDispatch && !isHuman) {
		return null;
	}
	if (request.method !== "POST") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}
	if (!isAdminRequest(request, env)) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;

	if (isDispatch) {
		if (!isStringArray(body.taskIds) || body.taskIds.length === 0) {
			return Response.json({ error: "body must be { taskIds: string[], priorityOrder?: string[], landFirst?: string[] }" }, { status: 400 });
		}
		try {
			const intents = await dispatchTasks(env, body.taskIds as TaskId[], isStringArray(body.priorityOrder) ? body.priorityOrder : undefined, undefined, isStringArray(body.landFirst) ? { landFirst: body.landFirst } : {});
			return Response.json({ intents });
		} catch (error) {
			if (error instanceof UnknownTasks) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			if (error instanceof DispatchFailed) {
				return Response.json({ error: error.message, intents: error.started, failed: error.failed }, { status: 502 });
			}
			throw error;
		}
	}

	const id = decodeURIComponent(url.pathname.slice("/api/human/".length));
	const choice = body.choice;
	if (typeof choice !== "string" || !(HUMAN_CHOICES as readonly string[]).includes(choice)) {
		return Response.json({ error: `choice must be one of ${HUMAN_CHOICES.join(", ")}` }, { status: 400 });
	}
	const intent = await intentStub(env, id).get().catch(() => null);
	let woken = 0;
	let status = intent?.status ?? null;
	if (intent?.status === "quarantined" && (choice === "Wait" || choice === "Split" || choice === "Depend")) {
		// The Intent edited symbols someone else holds. The choice settles who gets them.
		status = (await settleQuarantine(env, id, choice, { enqueue: gateEnqueue(env) })).status;
	} else if (intent?.status === "escalated" && (choice === "Retry" || choice === "Abandon")) {
		// Its re-derives kept failing. Retry gives it one more; Abandon ends it. The gate owns both.
		status = await landing(env).humanChoice(id, choice);
		woken = await wakeHumanWaiters(env, id, choice);
	} else {
		// The Intent's agent is paused on a stalemate and takes it from here.
		woken = await wakeHumanWaiters(env, id, choice);
	}
	await publish(env, { t: "human.resolved", id, choice });
	return Response.json({ ok: true, id, choice, woken, status });
}
