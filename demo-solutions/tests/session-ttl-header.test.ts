import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { handleRequest } from "../src/api/handlers.js";
import { json, withSessionHeaders } from "../src/api/responses.js";
import { makeDeps, makeSession, now, T0 } from "./support.js";

export const tests: Tests = {
	"authenticated responses carry the seconds left in the session": () => {
		const response = withSessionHeaders(json(200, {}), makeSession({ expiresAt: T0 + 90_500 }), now);
		assert.eq(response.headers["x-session-ttl"], "90");
		assert.eq(response.headers["x-session-user"], "usr_000001");
	},
	"the header appears on API responses": () => {
		const response = handleRequest({ method: "GET", path: "/profile", token: "ses_000001" }, makeDeps());
		assert.eq(response.headers["x-session-ttl"], "3600");
	},
};
