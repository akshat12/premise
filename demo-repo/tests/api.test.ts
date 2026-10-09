import * as assert from "../premise/assert.js";
import type { Tests } from "../premise/assert.js";
import { authenticate, handleRequest } from "../src/api/handlers.js";
import { errorRate, resetMetrics, snapshotMetrics } from "../src/api/metrics.js";
import { fromError, isSuccess, tooManyRequests, withSessionHeaders } from "../src/api/responses.js";
import * as responses from "../src/api/responses.js";
import { allowedMethods, matchPattern, matchRoute, routeKey } from "../src/api/routes.js";
import { fieldNames, isEmail, maxLength, minLength, oneOf, required, validateObject } from "../src/api/validate.js";
import { paginate } from "../src/store/repo.js";
import { ConflictError, NotFoundError, PermissionError, RateLimitedError, ValidationError } from "../src/util/errors.js";
import { makeDeps, makeInvoice, makeSession, now } from "./support.js";

export const tests: Tests = {
	"routes: patterns capture parameters": () => {
		assert.deepEq(matchPattern("/invoices/:id", "/invoices/inv_000007"), { id: "inv_000007" });
		assert.eq(matchPattern("/invoices/:id", "/invoices"), null);
		assert.eq(matchPattern("/profile", "/profiles"), null);
		assert.eq(matchRoute("GET", "/invoices/inv_1?expand=lines")?.route.name, "invoices.get");
		assert.eq(matchRoute("DELETE", "/profile"), null);
		assert.deepEq(allowedMethods("/profile"), ["GET", "PUT"]);
		assert.eq(routeKey({ method: "GET", pattern: "/profile" }), "GET /profile");
	},
	"authenticate recognises a signed-in caller and an anonymous one": () => {
		const deps = makeDeps();
		assert.deepEq(authenticate({ method: "GET", path: "/profile", token: "ses_000001" }, deps), { kind: "ok", session: makeSession() });
		assert.deepEq(authenticate({ method: "GET", path: "/profile" }, deps), { kind: "anonymous" });
	},
	"requests without a session are unauthorized": () => {
		const deps = makeDeps();
		const response = handleRequest({ method: "GET", path: "/profile" }, deps);
		assert.eq(response.status, 401);
		assert.deepEq(response.body, { error: "unauthorized" });
		assert.eq(deps.metrics.unauthorized, 1);
	},
	"unknown routes are not found": () => {
		assert.eq(handleRequest({ method: "GET", path: "/nope", token: "ses_000001" }, makeDeps()).status, 404);
	},
	"GET /profile returns the user, a default profile and session headers": () => {
		const response = handleRequest({ method: "GET", path: "/profile", token: "ses_000001" }, makeDeps());
		assert.eq(response.status, 200);
		const body = response.body as { user: { email: string; password?: unknown }; profile: { displayName: string } };
		assert.eq(body.user.email, "ada@example.com");
		assert.eq(body.user.password, undefined);
		assert.eq(body.profile.displayName, "Ada Lovelace");
		assert.eq(response.headers["x-session-user"], "usr_000001");
		assert.eq(response.headers["x-served-on"], "2026-03-01");
	},
	"PUT /profile validates and saves": () => {
		const deps = makeDeps();
		const bad = handleRequest({ method: "PUT", path: "/profile", token: "ses_000001", body: { locale: "english" } }, deps);
		assert.eq(bad.status, 400);
		assert.deepEq((bad.body as { fields: string[] }).fields, ["locale"]);
		const good = handleRequest({ method: "PUT", path: "/profile", token: "ses_000001", body: { bio: "Hello" } }, deps);
		assert.eq(good.status, 200);
		assert.eq(deps.profiles.get("usr_000001")?.bio, "Hello");
		assert.eq(handleRequest({ method: "PUT", path: "/profile", token: "ses_000001", body: "nope" }, deps).status, 400);
	},
	"GET /invoices lists the caller's invoices with totals": () => {
		const deps = makeDeps({ invoices: [makeInvoice(), makeInvoice({ id: "inv_000002", userId: "usr_000009" })] });
		const response = handleRequest({ method: "GET", path: "/invoices", token: "ses_000001" }, deps);
		const body = response.body as { items: { id: string; totals: { total: number } }[]; total: number };
		assert.eq(body.total, 1);
		assert.eq(body.items[0]?.id, "inv_000001");
		assert.eq(body.items[0]?.totals.total, 2574);
	},
	"GET /invoices/:id hides other people's invoices": () => {
		const deps = makeDeps({ invoices: [makeInvoice(), makeInvoice({ id: "inv_000002", userId: "usr_000009" })] });
		assert.eq(handleRequest({ method: "GET", path: "/invoices/inv_000001", token: "ses_000001" }, deps).status, 200);
		assert.eq(handleRequest({ method: "GET", path: "/invoices/inv_000002", token: "ses_000001" }, deps).status, 404);
		assert.eq(deps.metrics.errors, 1);
	},
	"metrics count requests per route": () => {
		const deps = makeDeps();
		handleRequest({ method: "GET", path: "/profile", token: "ses_000001" }, deps);
		handleRequest({ method: "GET", path: "/profile", token: "ses_000001" }, deps);
		handleRequest({ method: "GET", path: "/invoices/nope", token: "ses_000001" }, deps);
		const snapshot = snapshotMetrics(deps.metrics);
		assert.eq(snapshot.requests, 3);
		assert.deepEq(snapshot.byRoute, { "GET /profile": 2, "GET /invoices/:id": 1 });
		assert.eq(errorRate(deps.metrics), 1 / 3);
		resetMetrics(deps.metrics);
		assert.eq(deps.metrics.requests, 0);
		assert.eq(snapshot.requests, 3);
	},
	"responses: errors map to status codes": () => {
		assert.eq(fromError(new NotFoundError("invoice")).status, 404);
		assert.eq(fromError(new ConflictError("taken")).status, 409);
		assert.eq(fromError(new PermissionError("invoice.write")).status, 403);
		assert.deepEq(fromError(new ValidationError("bad", ["email"])).body, { error: "bad_request", message: "bad", fields: ["email"] });
		assert.eq(fromError(new RateLimitedError(1500)).headers["retry-after"], "2");
		assert.deepEq(fromError(new Error("secret detail")).body, { error: "internal" });
	},
	"responses: helpers set status, body and headers": () => {
		assert.ok(isSuccess(responses.created({ id: 1 })));
		assert.ok(!isSuccess(responses.forbidden()));
		assert.eq(responses.noContent().status, 204);
		assert.eq(tooManyRequests(90_000).headers["retry-after"], "90");
		const tagged = withSessionHeaders(responses.json(200, {}, { etag: "abc" }), makeSession(), now);
		assert.eq(tagged.headers.etag, "abc");
		assert.eq(tagged.headers["x-session-user"], "usr_000001");
	},
	"validate: schemas report the first problem per field": () => {
		const schema = { email: [required, isEmail], name: [required, minLength(2), maxLength(5)], role: [oneOf(["member", "admin"])] };
		assert.deepEq(validateObject({ email: "a@b.co", name: "Ada", role: "admin" }, schema), []);
		const errors = validateObject({ email: "nope", name: "Adaaaaaa", role: "root" }, schema);
		assert.deepEq(fieldNames(errors), ["email", "name", "role"]);
		assert.deepEq(validateObject({}, schema).map((error) => error.message), ["is required", "is required"]);
	},
	"pagination clamps the request": () => {
		const page = paginate([1, 2, 3, 4, 5], { page: 2, pageSize: 2 });
		assert.deepEq(page, { items: [3, 4], page: 2, pageSize: 2, total: 5, hasMore: true });
		assert.deepEq(paginate([1, 2, 3], { page: 0, pageSize: 1000 }).items, [1, 2, 3]);
		assert.eq(paginate([1, 2, 3], { page: 9, pageSize: 2 }).hasMore, false);
	},
};
