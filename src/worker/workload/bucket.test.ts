import { describe, expect, it } from "vitest";
import { TokenBucket } from "./bucket";

/** A bucket on a fake clock: sleeping moves time forward and is recorded. */
function fake(rate: number, capacity?: number) {
	let time = 0;
	const slept: number[] = [];
	const bucket = new TokenBucket(rate, capacity, () => time, async (ms) => {
		slept.push(ms);
		time += ms;
	});
	return { bucket, slept, advance: (ms: number) => void (time += ms), now: () => time };
}

describe("TokenBucket", () => {
	it("lets a full bucket's worth through at once, then makes callers wait", async () => {
		const { bucket, slept } = fake(10);
		for (let i = 0; i < 10; i++) {
			await bucket.take();
		}
		expect(slept).toEqual([]);
		await bucket.take();
		expect(slept).toEqual([100]); // one token at 10 a second
	});

	it("holds the long-run rate: 150 a second means 1,500 calls take about nine seconds after the first burst", async () => {
		const { bucket, now } = fake(150);
		for (let i = 0; i < 1500; i++) {
			await bucket.take();
		}
		expect(now()).toBeGreaterThanOrEqual(8900);
		expect(now()).toBeLessThanOrEqual(9200);
	});

	it("charges what a call costs", async () => {
		const { bucket, slept } = fake(100, 100);
		await bucket.take(60);
		await bucket.take(60);
		expect(slept).toEqual([200]); // 20 short at 100 a second
	});

	it("refills while nobody is asking, up to its capacity and no further", async () => {
		const { bucket, slept, advance } = fake(10, 20);
		await bucket.take(20);
		advance(60_000);
		await bucket.take(20);
		expect(slept).toEqual([]);
		await bucket.take(1);
		expect(slept).toEqual([100]);
	});

	it("lets through a call dearer than the whole bucket once the bucket is full", async () => {
		const { bucket, slept } = fake(10, 10);
		await bucket.take(500);
		expect(slept).toEqual([]);
		await bucket.take(500);
		expect(slept).toEqual([1000]);
	});

	it("serves callers that arrive together one after another", async () => {
		const { bucket, now } = fake(10, 1);
		await Promise.all(Array.from({ length: 5 }, () => bucket.take()));
		expect(now()).toBeGreaterThanOrEqual(400);
	});
});
