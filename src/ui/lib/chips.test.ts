import { describe, expect, it } from "vitest";
import type { PremiseEvent } from "../../shared/events";
import type { Premise } from "../../shared/types";
import realRun from "../fixtures/real-run.json";
import { reduceAll } from "./reduce";
import { ago, groupPremises, openCards, raceRows, sharedSymbols, timelineFor } from "./chips";
import { callsign } from "./view";

const events = realRun as PremiseEvent[];
const VERIFY = "src/auth/session.ts#verifySession";
const premise = (name: string, source: Premise["source"], state: Premise["state"] = "holding"): Premise => ({ symbol: `src/a.ts#${name}`, source, surfaceHash: "h", state });

const end = reduceAll(events);
const byCall = (state = end) => Object.fromEntries(Object.values(state.intents).filter((intent) => intent.kind === "agent").map((intent) => [callsign(intent).split(" ")[0], intent]));

describe("groupPremises", () => {
	it("groups by where the premise came from, asserted first, broken first within a group", () => {
		const groups = groupPremises([premise("zeta", "observed"), premise("beta", "derived"), premise("alpha", "observed", "broken"), premise("said", "asserted"), premise("mid", "observed")]);
		expect(groups.map((group) => [group.source, group.premises.map((item) => item.symbol.split("#")[1]), group.broken])).toEqual([
			["asserted", ["said"], 0],
			["derived", ["beta"], 0],
			["observed", ["alpha", "mid", "zeta"], 1],
		]);
		expect(groupPremises([])).toEqual([]);
	});

	it("for t02 in the recorded run, the asserted premise is the one that broke, with the reason", () => {
		const t02 = byCall().T02;
		const asserted = groupPremises(t02?.premises ?? []).find((group) => group.source === "asserted");
		expect(asserted?.broken).toBe(1);
		expect(asserted?.premises[0]).toMatchObject({ symbol: VERIFY, state: "broken", assertion: { description: "verifySession throws SessionExpiredError on expired tokens" } });
		expect(asserted?.premises[0]?.brokenBy?.reason).toMatch(/^assertion 'verifySession throws SessionExpiredError on expired tokens' no longer holds after intent /);
	});
});

describe("raceRows", () => {
	it("is null until there has been a race, then follows it to its winner", () => {
		expect(raceRows({})).toBeNull();
		expect(raceRows({ race: { rebase: "fail", rederive: "pending" } })).toEqual({ rebase: "fail", rederive: "pending" });
		// In the recorded run t02's rebase failed and its re-derive won.
		expect(raceRows(byCall().T02 ?? {})).toEqual({ rebase: "fail", rederive: "pass", winner: "rederive" });
		expect(raceRows(byCall().T04 ?? {})).toBeNull();
	});
});

describe("sharedSymbols", () => {
	it("is the symbols one agent changes while another relies on them", () => {
		const breakAt = events.findIndex((event) => event.t === "premise.broken");
		const before = reduceAll(events.slice(0, breakAt - 30));
		const shared = sharedSymbols(before);
		// t01 is changing verifySession while t02, t03 and t11 rely on it.
		expect(shared.has(VERIFY)).toBe(true);
		expect(shared.has("src/billing/invoice.ts#computeTotal")).toBe(true);
		// Nothing is shared once everything has landed.
		expect(sharedSymbols(end).size).toBe(0);
	});
});

describe("timelineFor", () => {
	it("tells one Intent's story, newest first", () => {
		const t02 = byCall().T02;
		const story = timelineFor(events, t02?.id ?? "", (assertionId) => (assertionId === "a-session-throws" ? "verifySession throws SessionExpiredError on expired tokens" : undefined));
		const texts = story.map((entry) => entry.text);
		expect(texts[0]).toBe("The re-derive passed the gate");
		expect(texts).toContain("Landed");
		expect(texts.some((text) => text.startsWith("Gate passed the re-derived work (3 acceptance checks)"))).toBe(true);
		expect(texts.some((text) => text.startsWith("Gate turned back the rebased work: its premise no longer holds (verifySession throws SessionExpiredError on expired tokens)"))).toBe(true);
		expect(texts).toContain("The rebase did not pass; re-deriving on a fresh fork");
		expect(texts).toContain("Trying a plain rebase first");
		const broke = story.find((entry) => entry.text.startsWith("Premise broke: assertion 'verifySession throws"));
		expect(broke).toMatchObject({ tone: "bad", other: byCall().T01?.id });
		expect(texts.at(-1)).toBe("Claiming");
		// Newest first, and only this Intent's events.
		expect(story.map((entry) => entry.seq)).toEqual([...story.map((entry) => entry.seq)].sort((a, b) => b - a));
		expect(timelineFor(events, "inobody00")).toEqual([]);
	});

	it("says when the ledger made an Intent wait or split", () => {
		const waited = Object.values(end.intents).find((intent) => timelineFor(events, intent.id).some((entry) => entry.text.startsWith("Ledger said")));
		expect(waited).toBeDefined();
	});
});

describe("ago", () => {
	it("reads as a person would say it", () => {
		expect(ago(10_000, 10_400)).toBe("just now");
		expect(ago(0, 12_000)).toBe("12s ago");
		expect(ago(0, 185_000)).toBe("3m ago");
		expect(ago(0, 2 * 3_600_000)).toBe("2h ago");
		expect(ago(5_000, 1_000)).toBe("just now");
	});
});

describe("openCards", () => {
	it("is the Intents still waiting for a person: asked, unanswered, and still stuck", () => {
		const asked = events.findIndex((event) => event.t === "human.needed");
		if (asked === -1) {
			expect(openCards(end)).toEqual([]);
			return;
		}
		const then = reduceAll(events.slice(0, asked + 1));
		expect(openCards(then)).toHaveLength(1);
		// In the recorded run the stalemate settled by itself when the other Intent landed, so no card is left.
		expect(openCards(end)).toEqual([]);
	});
});
