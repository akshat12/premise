/**
 * A token bucket: `take(cost)` waits until `cost` tokens are available. Tokens come back at
 * `ratePerSecond`, up to `capacity`. Used to keep the workload's calls to Artifacts well under
 * the platform's limit (2,000 control-plane requests per 10 seconds per namespace), so the real
 * agents always have room.
 */
export class TokenBucket {
	private available: number;
	private last: number;

	constructor(
		private readonly ratePerSecond: number,
		private readonly capacity: number = ratePerSecond,
		private readonly now: () => number = Date.now,
		private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	) {
		this.available = capacity;
		this.last = now();
	}

	private refill(): void {
		const time = this.now();
		this.available = Math.min(this.capacity, this.available + ((time - this.last) / 1000) * this.ratePerSecond);
		this.last = time;
	}

	async take(cost = 1): Promise<void> {
		// Something dearer than the whole bucket goes through when the bucket is full.
		const need = Math.min(cost, this.capacity);
		for (;;) {
			this.refill();
			if (this.available >= need) {
				this.available -= need;
				return;
			}
			await this.sleep(Math.max(1, Math.ceil(((need - this.available) / this.ratePerSecond) * 1000)));
		}
	}
}
