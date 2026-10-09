import { type Session, SessionExpiredError, type SessionStore, verifySession } from "../auth/session.js";
import { computeTotal } from "../billing/invoice.js";
import { type InvoiceRepository, paginate, type UserRepository } from "../store/repo.js";
import { applyProfileUpdate, defaultProfile, type Profile, type ProfileUpdate, validateProfile } from "../users/profile.js";
import { displayName, publicUser } from "../users/user.js";
import { NotFoundError } from "../util/errors.js";
import type { Clock } from "../util/time.js";
import { countRoute, increment, type Metrics } from "./metrics.js";
import * as responses from "./responses.js";
import type { ApiResponse } from "./responses.js";
import { matchRoute, type Method, routeKey } from "./routes.js";
import { isPlainObject } from "./validate.js";

export interface ApiRequest {
	method: Method;
	path: string;
	/** The session token from the Authorization header, if any. */
	token?: string;
	body?: unknown;
}

export interface HandlerDeps {
	sessions: SessionStore;
	users: UserRepository;
	invoices: InvoiceRepository;
	profiles: Map<string, Profile>;
	metrics: Metrics;
	now: Clock;
}

export type AuthResult = { kind: "ok"; session: Session } | { kind: "anonymous" } | { kind: "expired" };

/** Works out who is calling: a signed-in user, nobody, or someone whose session has run out. */
export function authenticate(request: ApiRequest, deps: HandlerDeps): AuthResult {
	try {
		const session = verifySession(request.token, deps.sessions, deps.now);
		return session === null ? { kind: "anonymous" } : { kind: "ok", session };
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return { kind: "expired" };
		}
		throw e;
	}
}

function profileOf(session: Session, deps: HandlerDeps): Profile {
	const existing = deps.profiles.get(session.userId);
	if (existing !== undefined) {
		return existing;
	}
	const user = deps.users.get(session.userId);
	if (user === undefined) {
		throw new NotFoundError("user");
	}
	return defaultProfile(user.id, displayName(user));
}

export function handleGetProfile(session: Session, deps: HandlerDeps): ApiResponse {
	const user = deps.users.get(session.userId);
	if (user === undefined) {
		throw new NotFoundError("user");
	}
	return responses.ok({ user: publicUser(user), profile: profileOf(session, deps) });
}

export function handleUpdateProfile(session: Session, body: unknown, deps: HandlerDeps): ApiResponse {
	if (!isPlainObject(body)) {
		return responses.badRequest("body must be an object");
	}
	const update = body as ProfileUpdate;
	const problems = validateProfile(update);
	if (problems.length > 0) {
		return responses.badRequest(problems[0]?.message ?? "invalid profile", problems.map((problem) => problem.field));
	}
	const updated = applyProfileUpdate(profileOf(session, deps), update);
	deps.profiles.set(session.userId, updated);
	return responses.ok({ profile: updated });
}

export function handleListInvoices(session: Session, deps: HandlerDeps): ApiResponse {
	const invoices = deps.invoices.forUser(session.userId).map((invoice) => ({
		id: invoice.id,
		number: invoice.number,
		status: invoice.status,
		totals: computeTotal(invoice),
	}));
	return responses.ok(paginate(invoices));
}

export function handleGetInvoice(session: Session, id: string, deps: HandlerDeps): ApiResponse {
	const invoice = deps.invoices.get(id);
	// Someone else's invoice is reported as missing, so ids cannot be probed.
	if (invoice === undefined || invoice.userId !== session.userId) {
		throw new NotFoundError("invoice");
	}
	return responses.ok({ invoice, totals: computeTotal(invoice) });
}

/** The single entry point: routes a request, authenticates it, and turns failures into responses. */
export function handleRequest(request: ApiRequest, deps: HandlerDeps): ApiResponse {
	increment(deps.metrics, "requests");
	const match = matchRoute(request.method, request.path);
	if (match === null) {
		return responses.notFound("route");
	}
	countRoute(deps.metrics, routeKey(match.route));

	const auth = authenticate(request, deps);
	if (match.route.name === "session.resume") {
		return auth.kind === "ok" ? responses.ok({ userId: auth.session.userId }) : auth.kind === "expired" ? responses.expired() : responses.unauthorized();
	}
	if (auth.kind !== "ok") {
		increment(deps.metrics, "unauthorized");
		return auth.kind === "expired" ? responses.expired() : responses.unauthorized();
	}

	try {
		const response = dispatch(match.route.name, auth.session, match.params, request, deps);
		return responses.withSessionHeaders(response, auth.session, deps.now);
	} catch (error) {
		increment(deps.metrics, "errors");
		return responses.fromError(error);
	}
}

function dispatch(name: string, session: Session, params: Record<string, string>, request: ApiRequest, deps: HandlerDeps): ApiResponse {
	switch (name) {
		case "profile.get":
			return handleGetProfile(session, deps);
		case "profile.update":
			return handleUpdateProfile(session, request.body, deps);
		case "invoices.list":
			return handleListInvoices(session, deps);
		case "invoices.get":
			return handleGetInvoice(session, params.id ?? "", deps);
		default:
			return responses.notFound("route");
	}
}
