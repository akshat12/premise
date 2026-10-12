// A step that must not be lost to one transient failure. Pure apart from the wait.

export interface PersistOptions {
	/** How many times the step is run in all. */
	tries?: number;
	/** The wait before the second try; it doubles after that. */
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `step`, again after a short wait if it throws, up to `tries` times. The last error is thrown. */
export async function persist<T>(step: () => Promise<T>, { tries = 3, delayMs = 150, sleep = pause }: PersistOptions = {}): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await step();
		} catch (error) {
			if (attempt >= tries) {
				throw error;
			}
			await sleep(delayMs * 2 ** (attempt - 1));
		}
	}
}

/**
 * The same, for a step whose failure must not stop what comes after it: if every try fails, the error
 * is reported through `onGiveUp` and `fallback` is returned.
 */
export async function persistOr<T>(step: () => Promise<T>, fallback: T, onGiveUp: (error: unknown) => void, options: PersistOptions = {}): Promise<T> {
	try {
		return await persist(step, options);
	} catch (error) {
		onGiveUp(error);
		return fallback;
	}
}
