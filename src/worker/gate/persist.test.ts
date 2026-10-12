import { describe, expect, it } from "vitest";
import { persist, persistOr } from "./persist";

const noWait = { sleep: async () => undefined };

describe("persist", () => {
	it("runs a step again after it throws, and returns what it finally gives", async () => {
		let calls = 0;
		const result = await persist(async () => {
			calls++;
			if (calls < 3) {
				throw new Error("not yet");
			}
			return "done";
		}, noWait);
		expect(result).toBe("done");
		expect(calls).toBe(3);
	});

	it("gives up after the tries it was given, with the last error", async () => {
		let calls = 0;
		await expect(
			persist(
				async () => {
					calls++;
					throw new Error(`failure ${calls}`);
				},
				{ ...noWait, tries: 2 },
			),
		).rejects.toThrow("failure 2");
		expect(calls).toBe(2);
	});

	it("waits a little longer each time", async () => {
		const waits: number[] = [];
		await persist(async () => (waits.length < 2 ? Promise.reject(new Error("x")) : "ok"), { delayMs: 100, sleep: async (ms) => void waits.push(ms) });
		expect(waits).toEqual([100, 200]);
	});
});

describe("persistOr", () => {
	it("returns the fallback and reports the error when every try fails, so what follows still happens", async () => {
		const reported: string[] = [];
		const result = await persistOr<string[]>(() => Promise.reject(new Error("down")), [], (error) => void reported.push(String(error)), noWait);
		expect(result).toEqual([]);
		expect(reported).toEqual(["Error: down"]);
	});

	it("does not report a step that came good", async () => {
		const reported: unknown[] = [];
		expect(await persistOr(async () => 7, 0, (error) => void reported.push(error), noWait)).toBe(7);
		expect(reported).toEqual([]);
	});
});
