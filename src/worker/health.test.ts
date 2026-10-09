import { describe, expect, it } from "vitest";
import { healthBody } from "./health";

describe("healthBody", () => {
	it("reports the configured adapters", () => {
		expect(healthBody({ REPO_STORE: "memory", LLM: "scripted" })).toEqual({
			ok: true,
			store: "memory",
			llm: "scripted",
		});
	});
});
