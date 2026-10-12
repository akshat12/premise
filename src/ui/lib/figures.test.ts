import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import liveRun from "../../../demo/runs/live.json";
import mainRun from "../../../demo/runs/main.json";
import { figuresFor } from "./figures";
import { readRecording } from "./recording";
import { reduceAll } from "./reduce";

const play = (events: readonly PremiseEvent[]) => reduceAll(events);
const at = (events: readonly PremiseEvent[], count: number) => {
	const seen = events.slice(0, count);
	const state = play(seen);
	return figuresFor(seen, state.intents, state.metrics);
};

describe("figuresFor", () => {
	const main = readRecording(mainRun).events;

	it("ends where the front-page recording's own metrics end", () => {
		const state = play(main);
		expect(at(main, main.length)).toEqual({
			agents: 4,
			workload: 0,
			premisesBroken: state.metrics.premisesBroken,
			rederived: state.metrics.rederives.succeeded,
			asked: 0,
			landed: state.metrics.intentsLanded,
			problems: 0,
		});
		expect(at(main, main.length)).toMatchObject({ premisesBroken: 2, rederived: 2, landed: 4 });
	});

	it("counts a break the moment it is in the log, without waiting for the next metrics event", () => {
		const second = main.findIndex((event, index) => event.t === "premise.broken" && main.slice(0, index).some((earlier) => earlier.t === "premise.broken"));
		const figures = at(main, second + 1);
		expect(figures.premisesBroken).toBe(2);
		expect(figures.landed).toBe(1);
		// The metrics events have not caught up yet, which is why they are not what is counted.
		expect(play(main.slice(0, second + 1)).metrics.premisesBroken).toBeLessThan(2);
	});

	it("starts at nothing", () => {
		expect(at(main, 0)).toEqual({ agents: 0, workload: 0, premisesBroken: 0, rederived: 0, asked: 0, landed: 0, problems: 0 });
	});

	it("shows the live-model run's regression", () => {
		const live = readRecording(liveRun).events;
		expect(at(live, live.length)).toMatchObject({ agents: 4, landed: 4, problems: 1 });
	});
});
