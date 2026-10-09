import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { createAuditLog, entriesFor } from "../src/auth/audit.js";
import { handleLogin } from "../src/auth/login.js";
import { createMemorySessionStore } from "../src/store/memory-store.js";

function deps() {
	return {
		store: createMemorySessionStore([
			{ id: "expired", userId: "u1", expiresAt: 0 },
			{ id: "valid", userId: "u2", expiresAt: 1000 },
		]),
		audit: createAuditLog(),
		now: () => 10,
	};
}

export const tests: Tests = {
	"an expired session writes an audit entry and returns expired": () => {
		const d = deps();
		const response = handleLogin("expired", d);
		assert.eq(response.status, 401);
		assert.deepEq(response.body, { error: "session_expired" });
		const entries = entriesFor(d.audit, "session.expired");
		assert.eq(entries.length, 1);
		assert.eq(entries[0]?.at, 10);
	},
	"a missing or unknown session writes no expired entry": () => {
		const d = deps();
		assert.deepEq(handleLogin(undefined, d).body, { error: "unauthorized" });
		assert.deepEq(handleLogin("never-issued", d).body, { error: "unauthorized" });
		assert.eq(entriesFor(d.audit, "session.expired").length, 0);
	},
	"a valid session writes no expired entry": () => {
		const d = deps();
		assert.eq(handleLogin("valid", d).status, 200);
		assert.eq(entriesFor(d.audit, "session.expired").length, 0);
	},
};
