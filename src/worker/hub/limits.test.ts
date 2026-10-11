import { describe, expect, it } from "vitest";
import { atCapacity, capacityMessage, MAX_SOCKETS } from "./limits";

describe("WebSocket limit", () => {
	it("is 200 sockets", () => {
		expect(MAX_SOCKETS).toBe(200);
		expect(atCapacity(0)).toBe(false);
		expect(atCapacity(199)).toBe(false);
		expect(atCapacity(200)).toBe(true);
		expect(atCapacity(5000)).toBe(true);
	});

	it("can be set lower, and says what the limit is", () => {
		expect(atCapacity(2, 3)).toBe(false);
		expect(atCapacity(3, 3)).toBe(true);
		expect(capacityMessage()).toContain("200 viewers");
		expect(capacityMessage(3)).toContain("3 viewers");
	});
});
