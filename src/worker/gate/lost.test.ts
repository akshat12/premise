import { describe, expect, it } from "vitest";
import { isLostRedo, LOST_AFTER_MS, LOST_CHECK_MS, nextLook } from "./lost";

const NOW = 1_000_000_000;
const entry = { intentId: "iabcdefgh" as never, attempt: 1, started: NOW - 2 * LOST_AFTER_MS };
const intent = { id: "iabcdefgh" as never, status: "rederiving" as const, rederiveAttempts: 1, headCommit: "c".repeat(40), repo: "iabcdefgh-r1" };

describe("a redo that finished but never reached the gate", () => {
	it("is found when every sign says so", () => {
		expect(isLostRedo(entry, intent, false, "complete", NOW)).toBe(true);
	});

	it("is left alone while anything says it may still be on its way", () => {
		expect(isLostRedo(entry, intent, true, "complete", NOW), "already queued").toBe(false);
		expect(isLostRedo(entry, intent, false, "running", NOW), "agent still running").toBe(false);
		expect(isLostRedo(entry, intent, false, null, NOW), "status unreadable").toBe(false);
		expect(isLostRedo({ ...entry, started: NOW - 1000 }, intent, false, "complete", NOW), "too recent").toBe(false);
		expect(isLostRedo({ ...entry, attempt: 0 }, intent, false, "complete", NOW), "start not finished").toBe(false);
	});

	it("is left alone when the Intent has moved on or has nothing of this attempt to land", () => {
		expect(isLostRedo(entry, null, false, "complete", NOW)).toBe(false);
		expect(isLostRedo(entry, { ...intent, status: "landed" }, false, "complete", NOW)).toBe(false);
		expect(isLostRedo(entry, { ...intent, rederiveAttempts: 2 }, false, "complete", NOW)).toBe(false);
		expect(isLostRedo(entry, { ...intent, headCommit: null }, false, "complete", NOW)).toBe(false);
		expect(isLostRedo(entry, { ...intent, repo: "iabcdefgh" }, false, "complete", NOW), "push is the first attempt's").toBe(false);
	});
});

describe("when the gate looks again while redos run", () => {
	const timeout = 20 * 60_000;
	it("looks soon while a redo is running, and never later than the oldest one's timeout", () => {
		expect(nextLook([], NOW, timeout)).toBeNull();
		expect(nextLook([entry], NOW, timeout)).toBe(NOW + LOST_CHECK_MS);
		const old = { ...entry, started: NOW - timeout + 1000 };
		expect(nextLook([old], NOW, timeout)).toBe(old.started + timeout + 1);
	});

	it("keeps the timeout alone for a start that has no attempt yet", () => {
		const starting = { ...entry, attempt: 0, started: NOW };
		expect(nextLook([starting], NOW, timeout)).toBe(NOW + timeout + 1);
	});
});
