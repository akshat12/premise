import { describe, expect, it } from "vitest";
import type { QueueEntry } from "./client";
import { BATCH_SIZE, pickBatch, taskPriority } from "./queue";

const entry = (intentId: string, priority: number, enqueuedAt: number): QueueEntry => ({ intentId, path: "rebase", priority, enqueuedAt, attempts: 0 });

describe("taskPriority", () => {
	const tasks = [{ id: "t01" }, { id: "t02" }, { id: "t03" }];

	it("is the task's place in the list, starting at 1", () => {
		expect(tasks.map((task) => taskPriority(tasks, task.id))).toEqual([1, 2, 3]);
	});

	it("puts tasks that are not in the list after all that are", () => {
		expect(taskPriority(tasks, "workload-17")).toBe(4);
		expect(taskPriority([], "t01")).toBe(1);
	});
});

describe("pickBatch", () => {
	it("takes the lowest priority number first, whatever order they were queued in", () => {
		const queue = [entry("c", 3, 10), entry("a", 1, 30), entry("b", 2, 20)];
		expect(pickBatch(queue).map((item) => item.intentId)).toEqual(["a", "b", "c"]);
	});

	it("is first in, first out within one priority, with the id as the last tie-break", () => {
		const queue = [entry("late", 5, 30), entry("y", 5, 10), entry("x", 5, 10), entry("early", 5, 5)];
		expect(pickBatch(queue).map((item) => item.intentId)).toEqual(["early", "x", "y", "late"]);
	});

	it("takes at most one batch and leaves the queue as it was", () => {
		const queue = Array.from({ length: 8 }, (_, index) => entry(`i${index}`, 8 - index, index));
		const before = JSON.stringify(queue);
		expect(BATCH_SIZE).toBe(5);
		expect(pickBatch(queue).map((item) => item.intentId)).toEqual(["i7", "i6", "i5", "i4", "i3"]);
		expect(pickBatch(queue, 2).map((item) => item.intentId)).toEqual(["i7", "i6"]);
		expect(pickBatch([])).toEqual([]);
		expect(JSON.stringify(queue)).toBe(before);
	});
});
