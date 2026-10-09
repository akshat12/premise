import { describe, expect, it } from "vitest";
import { constantTimeEqual, isAdminRequest } from "./admin-auth";

const request = (token?: string) =>
	new Request("http://premise.test/api/admin/smoke", { method: "POST", headers: token === undefined ? {} : { "x-admin-token": token } });

describe("constantTimeEqual", () => {
	it("matches equal strings only", () => {
		expect(constantTimeEqual("abc", "abc")).toBe(true);
		expect(constantTimeEqual("abc", "abd")).toBe(false);
		expect(constantTimeEqual("abc", "abcd")).toBe(false);
		expect(constantTimeEqual("", "")).toBe(true);
		expect(constantTimeEqual("é", "e")).toBe(false);
	});
});

describe("isAdminRequest", () => {
	it("accepts the configured token", () => {
		expect(isAdminRequest(request("s3cret"), { ADMIN_TOKEN: "s3cret" })).toBe(true);
	});

	it("rejects a wrong or missing token", () => {
		expect(isAdminRequest(request("nope"), { ADMIN_TOKEN: "s3cret" })).toBe(false);
		expect(isAdminRequest(request(), { ADMIN_TOKEN: "s3cret" })).toBe(false);
	});

	it("fails closed when no token is configured", () => {
		expect(isAdminRequest(request(""), {})).toBe(false);
		expect(isAdminRequest(request("anything"), {})).toBe(false);
		expect(isAdminRequest(request(""), { ADMIN_TOKEN: "" })).toBe(false);
	});
});
