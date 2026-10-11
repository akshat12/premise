import { describe, expect, it } from "vitest";
import { cachedJson, Memo } from "./memo";

function clock(start = 1000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("Memo", () => {
	it("loads once for a key and answers from memory after that", async () => {
		const memo = new Memo<string>(5000);
		let loads = 0;
		const load = async () => `value ${++loads}`;
		expect(await memo.get("trunk@abc", load)).toBe("value 1");
		expect(await memo.get("trunk@abc", load)).toBe("value 1");
		expect(loads).toBe(1);
		// Another key (trunk moved) is another question.
		expect(await memo.get("trunk@def", load)).toBe("value 2");
		expect(loads).toBe(2);
	});

	it("forgets an answer when its time is up", async () => {
		const time = clock();
		const memo = new Memo<number>(5000, 32, time.now);
		let loads = 0;
		const load = async () => ++loads;
		expect(await memo.get("head", load)).toBe(1);
		time.advance(4999);
		expect(await memo.get("head", load)).toBe(1);
		time.advance(1);
		expect(memo.peek("head")).toBeUndefined();
		expect(await memo.get("head", load)).toBe(2);
	});

	it("keeps an answer for ever when it is keyed by something that cannot change", async () => {
		const time = clock();
		const memo = new Memo<string>(Number.POSITIVE_INFINITY, 32, time.now);
		memo.set("repo@commit", "files");
		time.advance(365 * 24 * 60 * 60 * 1000);
		expect(memo.peek("repo@commit")).toBe("files");
	});

	it("remembers nothing when the load fails", async () => {
		const memo = new Memo<string>(5000);
		await expect(memo.get("k", async () => Promise.reject(new Error("repo not found")))).rejects.toThrow("repo not found");
		expect(memo.size).toBe(0);
		expect(await memo.get("k", async () => "ok")).toBe("ok");
	});

	it("holds at most `max` answers, dropping the one set longest ago", () => {
		const memo = new Memo<number>(5000, 2);
		memo.set("a", 1);
		memo.set("b", 2);
		memo.set("a", 3);
		memo.set("c", 4);
		expect(memo.size).toBe(2);
		expect(memo.peek("b")).toBeUndefined();
		expect(memo.peek("a")).toBe(3);
		expect(memo.peek("c")).toBe(4);
		memo.clear();
		expect(memo.size).toBe(0);
	});
});

describe("cachedJson", () => {
	it("lets the answer be reused for five seconds", async () => {
		const response = cachedJson({ ok: true });
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=5");
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(await response.json()).toEqual({ ok: true });
	});
});
