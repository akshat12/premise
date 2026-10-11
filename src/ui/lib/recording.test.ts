import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { IntentSummary } from "../../shared/events";
import type { IntentDiff } from "./diff";
import { agentIntentIds, formatRecording, readRecording } from "./recording";

const intent = (id: string, kind: "agent" | "workload"): IntentSummary => ({ id, kind, taskId: "t01", goal: "g", status: "planning", claims: [], premises: [], why: [], baseCommit: "b".repeat(40), headCommit: null, rederiveAttempts: 0 });
const events: PremiseEvent[] = [
	{ t: "intent.created", intent: intent("i00000001", "agent"), seq: 1, ts: 1000 },
	{ t: "intent.created", intent: intent("i00000002", "workload"), seq: 2, ts: 1100 },
	{ t: "intent.status", id: "i00000001", status: "working", seq: 3, ts: 1200 },
	{ t: "intent.created", intent: intent("i00000003", "agent"), seq: 4, ts: 1300 },
];
const diff: IntentDiff = { intentId: "i00000001", base: "b".repeat(40), head: "c".repeat(40), files: [{ path: "src/a.ts", status: "added", hunks: [{ oldStart: 0, newStart: 1, lines: [{ kind: "+", text: 'const s = "}}\\n";' }] }] }], fileCount: 1 };

describe("readRecording", () => {
	it("reads a recording that is only the event log", () => {
		expect(readRecording(events)).toEqual({ events, diffs: {} });
		expect(readRecording([])).toEqual({ events: [], diffs: {} });
	});

	it("reads a recording that carries diffs, leaving out anything that is not one", () => {
		expect(readRecording({ events, diffs: { i00000001: diff, i00000003: { error: "no such Intent" } } })).toEqual({ events, diffs: { i00000001: diff } });
		expect(readRecording({ events })).toEqual({ events, diffs: {} });
	});

	it("refuses anything else", () => {
		expect(() => readRecording({ diffs: {} })).toThrow("not a recorded run");
		expect(() => readRecording(null)).toThrow("not a recorded run");
	});
});

describe("formatRecording", () => {
	it("writes a recording with no diffs as the plain array, one event to a line", () => {
		const text = formatRecording({ events, diffs: {} });
		expect(text.split("\n")).toHaveLength(events.length + 3);
		expect(JSON.parse(text)).toEqual(events);
	});

	it("round-trips events and diffs", () => {
		const recording = { events, diffs: { i00000001: diff, i00000003: { ...diff, intentId: "i00000003", files: [] } } };
		const text = formatRecording(recording);
		expect(readRecording(JSON.parse(text))).toEqual(recording);
		// Still one event to a line, and one Intent's diff to a line.
		expect(text.split("\n").filter((line) => line.startsWith('{"t":'))).toHaveLength(events.length);
		expect(text.split("\n").filter((line) => line.startsWith('"i0000000'))).toHaveLength(2);
	});
});

describe("agentIntentIds", () => {
	it("lists the agents' Intents and not the scripted workload's", () => {
		expect(agentIntentIds(events)).toEqual(["i00000001", "i00000003"]);
	});
});
