import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import liveRun from "../../../demo/runs/live.json";
import mainRun from "../../../demo/runs/main.json";
import scaleRun from "../../../demo/runs/scale.json";
import { captionAt } from "./demo";
import { readRecording } from "./recording";
import { countWord, jobLine, stepAt, storyFor } from "./story";

const main = readRecording(mainRun).events;
const live = readRecording(liveRun).events;
const scale = readRecording(scaleRun).events;

describe("storyFor, on the front-page run of four agents", () => {
	const story = storyFor(main);
	const titles = story.steps.map((step) => step.title);

	it("tells the run in seven steps, in the log's order", () => {
		expect(titles).toEqual([
			"Four agents start work on the same code at the same time.",
			"Premise records what each one relies on.",
			"Agent 1 lands first. It changed verifySession.",
			"Two agents relied on how it used to behave. They are stopped at once.",
			"Agent 2's tests fail on the new code. Its work is redone and lands.",
			"Agent 4's tests all still pass. Only its premise caught the problem.",
			"Everything landed. Nothing broken reached trunk.",
		]);
		const places = story.steps.map((step) => step.at);
		expect(places).toEqual([...places].sort((a, b) => a - b));
		expect(places.at(-1)).toBe(main.length);
		expect(places[0]).toBeGreaterThan(0);
	});

	it("names the agents in task order, and says who was left alone", () => {
		const byTask = new Map(main.flatMap((event) => (event.t === "intent.created" ? [[event.intent.taskId.slice(0, 3), event.intent.id] as const] : [])));
		expect(story.names[byTask.get("t01") ?? ""]).toBe("Agent 1");
		expect(story.names[byTask.get("t02") ?? ""]).toBe("Agent 2");
		expect(story.names[byTask.get("t04") ?? ""]).toBe("Agent 3");
		expect(story.names[byTask.get("t11") ?? ""]).toBe("Agent 4");
		expect(story.notes).toEqual({ [byTask.get("t04") ?? ""]: "not affected" });
		expect(story.steps[3]?.body).toBe("Each is told what changed and who changed it. Agent 3 read it too, but relies only on its type, so it carries on.");
		expect(story.steps[3]?.focus).toHaveLength(2);
	});

	it("shows what the gate ran for the work whose tests all passed", () => {
		const step = story.steps[5];
		expect(step?.checks).toMatchObject({ own: 3, reference: 3, suite: 91, premise: "verifySession throws SessionExpiredError for an expired session" });
		expect(step?.focus).toEqual([step?.checks?.intentId]);
		// The step about tests failing has no such list.
		expect(story.steps[4]?.checks).toBeUndefined();
	});

	it("says the types did not change when they did not, which is why it still compiles", () => {
		expect(story.steps[2]?.body).toContain("The types did not change, so everything still compiles.");
	});
});

describe("storyFor, on the other two demo recordings", () => {
	it("says so when something broken reached trunk (the live-model run)", () => {
		const story = storyFor(live);
		const end = story.steps.at(-1);
		expect(end?.title).toBe("The run is over. One problem reached trunk.");
		expect(end?.body).toContain("redone work can pass every test and still be wrong");
		// Three were stopped there, two of them before they had pushed anything.
		expect(story.steps.map((step) => step.title)).toContain("Three agents relied on how it used to behave. They are stopped at once.");
		expect(story.steps.filter((step) => step.title.includes("was stopped while still working"))).toHaveLength(2);
		expect(story.notes).toEqual({});
	});

	it("does not say everything landed when the scripted workload lost some (the larger run)", () => {
		const story = storyFor(scale);
		expect(story.steps[0]?.title).toBe("Twelve agents start work on the same code at the same time.");
		const end = story.steps.at(-1);
		expect(end?.title).toBe("All twelve agents' work landed. Nothing broken reached trunk.");
		expect(end?.body).toContain("40 scripted workload Intents did not land.");
		expect(story.steps.length).toBeLessThanOrEqual(9);
		expect(Object.keys(story.names)).toHaveLength(12);
	});
});

describe("storyFor, on logs without that shape", () => {
	const created = (id: string, taskId: string, ts: number): PremiseEvent =>
		({ t: "intent.created", intent: { id, kind: "agent", taskId, goal: "g", status: "planning", claims: [], premises: [], why: [], baseCommit: "a".repeat(40), headCommit: null, rederiveAttempts: 0 }, seq: 0, ts }) as unknown as PremiseEvent;

	it("is empty for an empty log", () => {
		expect(storyFor([])).toEqual({ steps: [], names: {}, notes: {} });
	});

	it("falls back to one step per key moment, in the caption's words, when no landing broke an agent's premise", () => {
		const log = [created("i00000001", "t01-a", 0), created("i00000002", "t02-b", 10)].map((event, index) => ({ ...event, seq: index + 1 }));
		const story = storyFor(log, (at) => `caption at ${at}`);
		expect(story.steps.map((step) => step.title)).toEqual(["caption at 0", "caption at 2"]);
		expect(story.names).toEqual({ i00000001: "Agent 1", i00000002: "Agent 2" });
	});

	it("the captions are a real fallback for a real log", () => {
		const untilBreak = main.slice(0, 100);
		const story = storyFor(untilBreak, (at) => captionAt(untilBreak, at));
		expect(story.steps[0]?.title).toContain("A recorded run on real Artifacts: 4 agents");
	});
});

describe("stepAt", () => {
	const steps = storyFor(main).steps;

	it("is the last step that has been reached", () => {
		expect(stepAt(steps, 0)).toBe(-1);
		expect(stepAt(steps, steps[0]?.at ?? 0)).toBe(0);
		expect(stepAt(steps, (steps[3]?.at ?? 0) + 5)).toBe(3);
		expect(stepAt(steps, main.length)).toBe(steps.length - 1);
	});
});

describe("jobLine and countWord", () => {
	it("keeps the first sentence, without code ticks or asides", () => {
		expect(jobLine('Write an audit log entry with event "session.expired" whenever a login request (`handleLogin` in src/auth/login.ts) arrives with an expired session. The response must still be the `expired` response.')).toBe(
			'Write an audit log entry with event "session.expired" whenever a login request arrives with an…',
		);
		expect(jobLine("Make `x` faster.")).toBe("Make x faster");
	});

	it("spells small counts and writes large ones as numbers", () => {
		expect(countWord(2)).toBe("Two");
		expect(countWord(12)).toBe("Twelve");
		expect(countWord(16)).toBe("16");
	});
});
