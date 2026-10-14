import { describe, expect, it } from "vitest";
import { dismissPhoneNote, isFirstVisit, phoneNoteDismissed, rememberVisit, SLIDES_CARD_KEY } from "./firstVisit";

const memory = (start: Record<string, string> = {}) => {
	const kept = new Map(Object.entries(start));
	return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
};
const refusing = {
	getItem: (): string | null => {
		throw new Error("refused");
	},
	setItem: (): void => {
		throw new Error("refused");
	},
};

describe("the first-visit card", () => {
	it("is shown on the first visit and never after it has been shown once", () => {
		const kept = memory();
		expect(isFirstVisit(kept, "")).toBe(true);
		expect(rememberVisit(kept)).toBe(true);
		expect(isFirstVisit(kept, "")).toBe(false);
	});

	it("stays away from a link to something in particular, and leaves the first visit unspent", () => {
		const kept = memory();
		for (const search of ["?run=3", "?live", "?results", "?demo=scale", "?frame=420", "?admin"]) {
			expect(isFirstVisit(kept, search)).toBe(false);
		}
		expect(isFirstVisit(kept, "")).toBe(true);
	});

	it("stays away when the browser will not remember", () => {
		expect(isFirstVisit(null, "")).toBe(false);
		expect(isFirstVisit(refusing, "")).toBe(false);
		expect(rememberVisit(refusing)).toBe(false);
		expect(rememberVisit(null)).toBe(false);
	});

	it("goes by its own key", () => {
		expect(isFirstVisit(memory({ other: "1" }), "")).toBe(true);
		expect(isFirstVisit(memory({ [SLIDES_CARD_KEY]: "1" }), "")).toBe(false);
	});
});

describe("the phone note", () => {
	it("shows until dismissed, then stays dismissed", () => {
		const kept = memory();
		expect(phoneNoteDismissed(kept)).toBe(false);
		dismissPhoneNote(kept);
		expect(phoneNoteDismissed(kept)).toBe(true);
	});

	it("shows when the browser will not remember, and dismissing it there does not throw", () => {
		expect(phoneNoteDismissed(null)).toBe(false);
		expect(phoneNoteDismissed(refusing)).toBe(false);
		expect(() => dismissPhoneNote(refusing)).not.toThrow();
	});
});
