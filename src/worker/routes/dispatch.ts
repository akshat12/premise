// The two things a person does: dispatch work, and settle an escalated Intent. Both need the admin token.
import type { TaskId } from "../../shared/types";
import { isAdminRequest } from "../admin-auth";
import { wakeHumanWaiters } from "../agent/wake";
import { dispatchTasks, UnknownTasks } from "../dispatch";
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
			return Response.json({ error: "body must be { taskIds: string[], priorityOrder?: string[] }" }, { status: 400 });
		}
		try {
			const intents = await dispatchTasks(env, body.taskIds as TaskId[], isStringArray(body.priorityOrder) ? body.priorityOrder : undefined);
			return Response.json({ intents });
		} catch (error) {
			if (error instanceof UnknownTasks) {
				return Response.json({ error: error.message }, { status: 400 });
			}
			throw error;
		}
	}

	const id = decodeURIComponent(url.pathname.slice("/api/human/".length));
	const choice = body.choice;
	if (typeof choice !== "string" || !(HUMAN_CHOICES as readonly string[]).includes(choice)) {
		return Response.json({ error: `choice must be one of ${HUMAN_CHOICES.join(", ")}` }, { status: 400 });
	}
	const woken = await wakeHumanWaiters(env, id, choice);
	await publish(env, { t: "human.resolved", id, choice });
	return Response.json({ ok: true, id, choice, woken });
}
