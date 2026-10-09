import { describe, expect, it } from "vitest";
import { pollUntilReady, type RepoStatus } from "./import-trunk";

function sequence(statuses: RepoStatus[]) {
	let calls = 0;
	return { status: async () => statuses[Math.min(calls++, statuses.length - 1)] ?? "missing", calls: () => calls };
}

describe("pollUntilReady", () => {
	it("returns as soon as the repo is ready", async () => {
		const source = sequence(["importing", "importing", "ready", "ready"]);
		const sleeps: number[] = [];
		const result = await pollUntilReady(source.status, { attempts: 10, delayMs: 50, sleep: async (ms) => void sleeps.push(ms) });
		expect(result).toEqual({ status: "ready", tries: 3 });
		expect(source.calls()).toBe(3);
		expect(sleeps).toEqual([50, 50]);
	});

	it("gives up after the allowed attempts and reports the last status", async () => {
		const source = sequence(["missing", "importing"]);
		const sleeps: number[] = [];
		const result = await pollUntilReady(source.status, { attempts: 4, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
		expect(result).toEqual({ status: "importing", tries: 4 });
		// No sleep after the last attempt.
		expect(sleeps).toHaveLength(3);
	});

	it("does not sleep when the first check is ready", async () => {
		const sleeps: number[] = [];
		const result = await pollUntilReady(async () => "ready", { attempts: 3, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
		expect(result).toEqual({ status: "ready", tries: 1 });
		expect(sleeps).toEqual([]);
	});
});
