// Calls to the Worker that need the admin token. The token is typed in once and kept for the
// browser session only. It is never put in a URL and never logged.
import type { TaskDef } from "../../shared/types";

const TOKEN_KEY = "premise-admin-token";

export function loadToken(): string {
	try {
		return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return ""; // storage is unavailable (private mode, blocked): the token is asked for again
	}
}

export function saveToken(token: string): void {
	try {
		window.sessionStorage.setItem(TOKEN_KEY, token);
	} catch {
		// nothing to do: it simply will not be remembered
	}
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

/** What went wrong, in words a person can act on. */
export function explain(error: unknown): string {
	if (error instanceof ApiError) {
		return error.status === 401 ? "That admin token was not accepted. Check it and try again." : error.message;
	}
	return "Couldn't reach the Worker. Check that it is running, then try again.";
}

export async function postAdmin<T>(path: string, body: unknown, token: string): Promise<T> {
	const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": token }, body: JSON.stringify(body) });
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (!response.ok) {
		const message = typeof (parsed as { error?: unknown } | undefined)?.error === "string" ? (parsed as { error: string }).error : `The Worker answered ${response.status}.`;
		throw new ApiError(response.status, message);
	}
	return parsed as T;
}

export async function fetchTasks(): Promise<TaskDef[]> {
	const response = await fetch("/api/tasks");
	if (!response.ok) {
		throw new ApiError(response.status, `The Worker answered ${response.status}.`);
	}
	return (await response.json()) as TaskDef[];
}

/** The task whose change the others rely on. Landing it first is the order the demo is about. */
export const LAND_FIRST = "t01-null-expired";

export interface DispatchRequest {
	taskIds: string[];
	landFirst: boolean;
	workload: number;
	seed: number;
}

/** Dispatches the chosen tasks, then starts the scripted workload if one was asked for. Returns what to tell the person. */
export async function dispatch(request: DispatchRequest, token: string): Promise<string> {
	const parts: string[] = [];
	if (request.taskIds.length > 0) {
		const body = { taskIds: request.taskIds, ...(request.landFirst && request.taskIds.includes(LAND_FIRST) ? { landFirst: [LAND_FIRST] } : {}) };
		const result = await postAdmin<{ intents: string[] }>("/api/dispatch", body, token);
		parts.push(`${result.intents.length} task${result.intents.length === 1 ? "" : "s"} dispatched`);
	}
	if (request.workload > 0) {
		const result = await postAdmin<{ started: number }>("/api/admin/workload", { n: request.workload, seed: request.seed }, token);
		parts.push(`${result.started} workload Intents started`);
	}
	return parts.length === 0 ? "Nothing was selected." : `${parts.join("; ")}.`;
}

export const answerCard = (intentId: string, choice: string, token: string) => postAdmin<{ ok: boolean; status: string | null }>(`/api/human/${encodeURIComponent(intentId)}`, { choice }, token);
export const resetDemo = (token: string) => postAdmin<{ ok: boolean; trunk: string }>("/api/admin/reset-demo", {}, token);
