// The order Intents go through the gate in. Pure.
import type { TaskDef, TaskId } from "../../shared/types";
import type { QueueEntry } from "./client";

export const BATCH_SIZE = 5;
/** How many scripted workload Intents may land as one commit. */
export const WORKLOAD_BATCH_SIZE = 10;

/** A task's place in the task list, starting at 1. Tasks that are not in the list go after all that are. */
export function taskPriority(tasks: readonly Pick<TaskDef, "id">[], taskId: TaskId): number {
	const index = tasks.findIndex((task) => task.id === taskId);
	return index === -1 ? tasks.length + 1 : index + 1;
}

/** The next Intents to gate: lowest priority number first, then the longest queued. */
export function pickBatch(queue: readonly QueueEntry[], size: number = BATCH_SIZE): QueueEntry[] {
	return [...queue].sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt || (a.intentId < b.intentId ? -1 : 1)).slice(0, size);
}
