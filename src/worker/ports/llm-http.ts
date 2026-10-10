// Shared HTTP plumbing for the model adapters: one POST with retries.

export class LlmHttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		readonly url: string,
	) {
		super(`LLM request failed with HTTP ${status} from ${url}: ${body.slice(0, 2000)}`);
		this.name = "LlmHttpError";
	}
}

export interface HttpOptions {
	/** Defaults to the global `fetch`, looked up at call time so tests can stub it. */
	fetch?: typeof fetch;
	/** Defaults to a real timer. Tests pass a no-op. */
	sleep?: (ms: number) => Promise<void>;
	/** Defaults to Math.random. */
	random?: () => number;
}

export const MAX_RETRIES = 3;
const BACKOFF_SECONDS = [1, 2, 4];
const MAX_RETRY_AFTER_MS = 30_000;

/** Rate limits, timeouts, lock conflicts and server-side failures (including Anthropic's 529 "overloaded"). */
export function isRetryable(status: number): boolean {
	return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** How long to wait before retry number `attempt` (0-based): the server's `retry-after` if it sent one, else 1, 2, 4 s with jitter. */
export function retryDelayMs(attempt: number, retryAfter: string | null, random: () => number): number {
	const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
	}
	const base = (BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)] ?? 4) * 1000;
	// Between 50% and 100% of the step, so many agents retrying at once do not line up.
	return Math.round(base * (0.5 + random() * 0.5));
}

/** POSTs JSON and returns the parsed JSON reply. Retries retryable statuses and network errors up to three times. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, options: HttpOptions = {}): Promise<unknown> {
	const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const random = options.random ?? Math.random;
	const payload = JSON.stringify(body);

	for (let attempt = 0; ; attempt++) {
		let response: Response;
		try {
			response = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });
		} catch (error) {
			if (attempt >= MAX_RETRIES) {
				throw error;
			}
			await sleep(retryDelayMs(attempt, null, random));
			continue;
		}
		if (response.ok) {
			return await response.json();
		}
		const text = await response.text();
		if (!isRetryable(response.status) || attempt >= MAX_RETRIES) {
			throw new LlmHttpError(response.status, text, url);
		}
		await sleep(retryDelayMs(attempt, response.headers.get("retry-after"), random));
	}
}
