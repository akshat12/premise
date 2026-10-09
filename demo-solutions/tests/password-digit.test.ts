import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { checkPasswordPolicy, DEFAULT_PASSWORD_POLICY, describeIssue } from "../src/auth/password.js";

export const tests: Tests = {
	"a password with no digit is rejected by default": () => {
		assert.deepEq(checkPasswordPolicy("Correct-Horse-Battery"), ["needs_digit"]);
		assert.eq(DEFAULT_PASSWORD_POLICY.requireDigit, true);
		assert.eq(describeIssue("needs_digit"), "Include at least one digit.");
	},
	"a password with a digit is accepted": () => {
		assert.deepEq(checkPasswordPolicy("Correct-Horse-9"), []);
	},
	"the digit rule can be turned off": () => {
		assert.deepEq(checkPasswordPolicy("Correct-Horse-Battery", { ...DEFAULT_PASSWORD_POLICY, requireDigit: false }), []);
	},
};
