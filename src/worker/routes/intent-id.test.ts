import { describe, expect, it } from "vitest";
import { newIntentId } from "../../shared/ids";
import { isIntentId, parseIntentPath } from "./intent-id";

describe("isIntentId", () => {
	it("accepts what newIntentId makes", () => {
		for (let round = 0; round < 50; round++) {
			expect(isIntentId(newIntentId())).toBe(true);
		}
		expect(isIntentId("i3k9x0a2q")).toBe(true);
	});

	it("refuses everything else", () => {
		for (const bad of ["", "i", "i3k9x0a2", "i3k9x0a2qq", "x3k9x0a2q", "I3K9X0A2Q", "i3k9x0a2Q", "i3k9x0a2q-r1", "i3k9-0a2q", "i3k9x0a2q\n", " i3k9x0a2q", "i3k9x0a2%71", "../../admin", "trunk"]) {
			expect(isIntentId(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});

describe("parseIntentPath", () => {
	it("splits the id from what follows it", () => {
		expect(parseIntentPath("/api/intents/i3k9x0a2q")).toEqual({ id: "i3k9x0a2q", rest: "" });
		expect(parseIntentPath("/api/intents/i3k9x0a2q/diff")).toEqual({ id: "i3k9x0a2q", rest: "diff" });
		expect(parseIntentPath("/api/intents/i3k9x0a2q/diff/more")).toEqual({ id: "i3k9x0a2q", rest: "diff/more" });
		expect(parseIntentPath("/api/intents/%2e%2e")).toEqual({ id: "%2e%2e", rest: "" });
	});

	it("is null for other paths", () => {
		expect(parseIntentPath("/api/intents")).toBeNull();
		expect(parseIntentPath("/api/intents/")).toBeNull();
		expect(parseIntentPath("/api/intent/i3k9x0a2q")).toBeNull();
	});
});
