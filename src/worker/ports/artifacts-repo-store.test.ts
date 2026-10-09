import { describe, expect, it } from "vitest";
import { isArtifactsError } from "./artifacts-repo-store";

const ALREADY_EXISTS = { codes: ["ALREADY_EXISTS"], message: /already exists/i };

describe("isArtifactsError", () => {
	it("matches the binding's error by code", () => {
		const error = Object.assign(new Error("whatever"), { name: "ArtifactsError", code: "ALREADY_EXISTS" });
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(true);
	});

	it("trusts the code over the message when a code is present", () => {
		const error = Object.assign(new Error("repo already exists"), { code: "NOT_FOUND" });
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(false);
	});

	it("falls back to the message for the code-less error the remote binding throws in local dev", () => {
		// Shape observed under `vite dev`: a plain Error, no `code`.
		const error = new Error("ArtifactsError: repo already exists: smoke-e706de2b-0-empty");
		expect(isArtifactsError(error, ALREADY_EXISTS)).toBe(true);
	});

	it("does not match unrelated errors or non-errors", () => {
		expect(isArtifactsError(new Error("network down"), ALREADY_EXISTS)).toBe(false);
		expect(isArtifactsError("already exists", ALREADY_EXISTS)).toBe(false);
		expect(isArtifactsError(null, ALREADY_EXISTS)).toBe(false);
	});
});
