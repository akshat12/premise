import { useRef } from "react";
import type { PremiseEvent } from "../../shared/events";
import { initialViewState, reduce, type ViewState } from "./reduce";

/**
 * The view state for an event log that only ever grows (or starts again from empty). Each render
 * applies just the events that arrived since the last one, so a log of thousands of events is
 * not reduced from the beginning every time one more comes in.
 */
export function useViewState(events: readonly PremiseEvent[]): ViewState {
	const cache = useRef<{ count: number; firstSeq: number | undefined; state: ViewState }>({ count: 0, firstSeq: undefined, state: initialViewState() });
	const held = cache.current;
	const restarted = events.length < held.count || events[0]?.seq !== held.firstSeq;
	let state = restarted ? initialViewState() : held.state;
	for (let index = restarted ? 0 : held.count; index < events.length; index++) {
		state = reduce(state, events[index] as PremiseEvent);
	}
	cache.current = { count: events.length, firstSeq: events[0]?.seq, state };
	return state;
}
