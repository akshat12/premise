import { describe, expect, it } from "vitest";
import type { IntentId } from "../../shared/types";
import type { IntentView } from "./reduce";
import { callsign } from "./view";
import { workloadLines, workloadReason } from "./workload";

const intent = (id: string, goal: string, status: IntentView["status"], lastNote?: string, kind: IntentView["kind"] = "workload") =>
	({ id, kind, taskId: kind === "workload" ? "workload" : "t01-null-expired", goal, status, claims: [], premises: [], why: [], ...(lastNote ? { lastNote } : {}) }) as unknown as IntentView;

const board = {
	ia0000001: intent("ia0000001", "w7_11: touch the body of planPrice (same function as w7_1)", "landed"),
	ia0000002: intent("ia0000002", "w7_1: touch the body of planPrice", "failed", "could not get src/billing/plan.ts#planPrice: Intent ia0000001 still holds it after 3 retries"),
	ia0000003: intent("ia0000003", "w7_2: add a helper next to formatMoney", "gating"),
	ia0000004: intent("ia0000004", "w7_3: add a field to Invoice", "failed", "Typecheck failed on the new trunk"),
	ia0000005: intent("ia0000005", "Invoices must round tax half to even", "landed", undefined, "agent"),
} as Record<IntentId, IntentView>;
const nameOf = (id: IntentId) => (board[id] ? callsign(board[id] as IntentView) : id);

describe("the workload's list", () => {
	it("lists every workload Intent and no agent, in the order the workload made them", () => {
		expect(workloadLines(board, nameOf).map((line) => line.name)).toEqual(["w7_1", "w7_2", "w7_3", "w7_11"]);
	});

	it("says where each one got to, and why it did not land", () => {
		const lines = Object.fromEntries(workloadLines(board, nameOf).map((line) => [line.name, line]));
		expect(lines.w7_11).toMatchObject({ edit: "touch the body of planPrice (same function as w7_1)", state: "landed", reason: null });
		expect(lines.w7_2).toMatchObject({ state: "in flight", reason: null });
		expect(lines.w7_1).toMatchObject({ state: "did not land", reason: "Gave up waiting: w7_11 was changing planPrice." });
		expect(lines.w7_3).toMatchObject({ state: "did not land", reason: "Typecheck failed on the new trunk" });
	});

	it("puts any other note in words, with Intent ids as names", () => {
		expect(workloadReason("Text conflict with trunk after ia0000001 landed", nameOf)).toBe("Text conflict with trunk after w7_11 landed");
		expect(workloadReason(undefined, nameOf)).toBeNull();
		expect(workloadReason("could not get a.ts#x, b.ts#y: Intent ia0000001 still holds it after 3 retries", nameOf)).toBe("Gave up waiting: w7_11 was changing x, y.");
	});

	it("names a workload Intent by its tag, and an agent's Intent as before", () => {
		expect(callsign(board.ia0000001 as IntentView)).toBe("w7_11");
		expect(callsign(board.ia0000005 as IntentView)).toBe("T01 NULL");
		expect(callsign({ id: "ib0000009", taskId: "workload", goal: "no tag here" })).toBe("IB0000009");
	});
});
