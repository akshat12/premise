// A past run of the live board, read back from the Worker's record of it.
import type { PremiseEvent } from "../../shared/events";

/** The whole log of a past run, asked for a page at a time. */
export async function fetchPastRun(id: number): Promise<PremiseEvent[]> {
	const events: PremiseEvent[] = [];
	for (let since = 0; ; ) {
		const response = await fetch(`/api/runs/${id}/history?since=${since}`);
		if (!response.ok) {
			throw new Error(`run ${id}: ${response.status}`);
		}
		const page = (await response.json()) as PremiseEvent[];
		events.push(...page);
		const last = page.at(-1);
		if (last === undefined || page.length < 5000) {
			return events;
		}
		since = last.seq;
	}
}
