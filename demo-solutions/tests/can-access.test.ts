import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { canAccess } from "../src/users/roles.js";

export const tests: Tests = {
	"each resource has a minimum role": () => {
		assert.ok(canAccess(["viewer"], "profile"));
		assert.ok(!canAccess(["viewer"], "invoices"));
		assert.ok(canAccess(["member"], "invoices"));
		assert.ok(!canAccess(["member"], "billing"));
		assert.ok(canAccess(["billing"], "billing"));
		assert.ok(!canAccess(["billing"], "members"));
		assert.ok(canAccess(["admin"], "members"));
	},
	"a higher role can open everything below it": () => {
		for (const resource of ["profile", "invoices", "billing", "members"] as const) {
			assert.ok(canAccess(["admin"], resource));
		}
	},
	"any one of several roles is enough, and no roles means no access": () => {
		assert.ok(canAccess(["viewer", "billing"], "billing"));
		assert.ok(!canAccess([], "profile"));
	},
};
