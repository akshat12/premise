import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { verifySession } from "../src/auth/session.js";
import { createMemorySessionStore } from "../src/store/memory-store.js";

export const tests: Tests = {
	"verifySession returns null for an expired session": () => {
		const store = createMemorySessionStore([{ id: "s1", userId: "u1", expiresAt: 0 }]);
		assert.eq(verifySession("s1", store, () => 10), null);
	},
	"verifySession still returns a session that has time left": () => {
		const session = { id: "s1", userId: "u1", expiresAt: 100 };
		assert.deepEq(verifySession("s1", createMemorySessionStore([session]), () => 10), session);
	},
};
