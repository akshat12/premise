import { describe, expect, it } from "vitest";
import { release } from "./release";

describe("release", () => {
	it("disposes each stub it is given, singly or in a list", () => {
		let disposed = 0;
		const stub = () => ({ [Symbol.dispose]: () => void disposed++ });
		release(stub(), [stub(), stub()]);
		expect(disposed).toBe(3);
	});

	it("passes over what is not a stub, and a stub that throws", () => {
		expect(() =>
			release(undefined, null, 7, "text", {}, {
				[Symbol.dispose]: () => {
					throw new Error("already gone");
				},
			}),
		).not.toThrow();
	});
});
