import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { checkPasswordPolicy, describeIssue, hashPassword, isAcceptablePassword, verifyPassword } from "../src/auth/password.js";
import { can, gainedPermissions, requirePermission } from "../src/auth/permissions.js";
import { bearerToken, issueToken, parseToken, requireToken, tokenFingerprint, TokenParseError } from "../src/auth/token.js";
import { PermissionError } from "../src/util/errors.js";
import { PASSWORD } from "./support.js";

export const tests: Tests = {
	"password: a strong password has no issues": () => {
		assert.deepEq(checkPasswordPolicy(PASSWORD), []);
		assert.ok(isAcceptablePassword(PASSWORD));
	},
	"password: short passwords are rejected": () => {
		assert.deepEq(checkPasswordPolicy("Ab3"), ["too_short"]);
		assert.eq(describeIssue("too_short"), "Use at least 10 characters.");
	},
	"password: mixed case is required by default": () => {
		assert.deepEq(checkPasswordPolicy("alllowercase-9"), ["needs_mixed_case"]);
		assert.deepEq(checkPasswordPolicy("alllowercase-9", { minLength: 10, requireMixedCase: false, requireDigit: false }), []);
	},
	"password: whitespace is rejected": () => {
		assert.deepEq(checkPasswordPolicy("Correct Horse 9"), ["has_whitespace"]);
	},
	"password: hashes verify only the original password": () => {
		const stored = hashPassword(PASSWORD, "salt-1");
		assert.ok(verifyPassword(PASSWORD, stored));
		assert.ok(!verifyPassword(`${PASSWORD}!`, stored));
		assert.ok(hashPassword(PASSWORD, "salt-2").digest !== stored.digest);
	},
	"token: issue and parse round-trip": () => {
		const token = issueToken("ses_000001", "secret");
		assert.deepEq(parseToken(token, "secret"), { ok: true, value: "ses_000001" });
		assert.eq(requireToken(token, "secret"), "ses_000001");
		assert.eq(tokenFingerprint(token).length, 8);
	},
	"token: tampering and wrong secrets are detected": () => {
		const token = issueToken("ses_000001", "secret");
		assert.deepEq(parseToken(token, "other"), { ok: false, error: "bad_signature" });
		assert.deepEq(parseToken(token.replace("ses_000001", "ses_000002"), "secret"), { ok: false, error: "bad_signature" });
		assert.deepEq(parseToken("nonsense", "secret"), { ok: false, error: "malformed" });
		assert.deepEq(parseToken(token.replace("acme", "evil"), "secret"), { ok: false, error: "wrong_prefix" });
		assert.throws(() => requireToken("nonsense", "secret"), TokenParseError);
	},
	"token: bearerToken reads the Authorization header": () => {
		assert.eq(bearerToken("Bearer abc.def"), "abc.def");
		assert.eq(bearerToken("bearer   abc"), "abc");
		assert.eq(bearerToken("Basic abc"), undefined);
		assert.eq(bearerToken(undefined), undefined);
	},
	"permissions: roles carry the expected permissions": () => {
		assert.ok(can("admin", "user.invite"));
		assert.ok(!can("member", "invoice.write"));
		assert.ok(can("billing", "billing.manage"));
		assert.deepEq(gainedPermissions("viewer", "member"), ["profile.write"]);
		requirePermission("admin", "user.deactivate");
		assert.throws(() => requirePermission("viewer", "profile.write"), PermissionError);
	},
};
