// A small in-isolate memo for the public read routes, so the same question asked many times in a
// few seconds reads the repo once. It lives as long as the isolate does and is shared by every
// request the isolate serves; nothing is lost when it is dropped.

/**
 * Remembers up to `max` answers by key, each for `ttlMs` (Infinity for answers that can never
 * change, such as anything keyed by a commit). Values are kept, not promises: a promise made
 * while serving one request must not be awaited by another.
 */
export class Memo<V> {
	private readonly entries = new Map<string, { value: V; expires: number }>();

	constructor(
		private readonly ttlMs: number,
		private readonly max = 32,
		private readonly now: () => number = Date.now,
	) {}

	/** The remembered answer, or undefined if there is none or it is too old. */
	peek(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		if (entry.expires <= this.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: V): void {
		// Re-inserting moves the key to the end, so the first key is always the oldest.
		this.entries.delete(key);
		this.entries.set(key, { value, expires: this.now() + this.ttlMs });
		for (const oldest of this.entries.keys()) {
			if (this.entries.size <= this.max) {
				break;
			}
			this.entries.delete(oldest);
		}
	}

	/** The remembered answer for `key`, or else whatever `load` returns, which is then remembered. A `load` that throws leaves nothing behind. */
	async get(key: string, load: () => Promise<V>): Promise<V> {
		const hit = this.peek(key);
		if (hit !== undefined) {
			return hit;
		}
		const value = await load();
		this.set(key, value);
		return value;
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
	}
}

/** How long a browser or a cache in front of the Worker may reuse a public read. */
export const PUBLIC_MAX_AGE_S = 5;

/** A JSON response that may be reused for a few seconds. */
export function cachedJson(body: unknown, maxAgeSeconds: number = PUBLIC_MAX_AGE_S): Response {
	return Response.json(body, { headers: { "Cache-Control": `public, max-age=${maxAgeSeconds}` } });
}
