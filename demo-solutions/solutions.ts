// Reference solutions for the demo tasks, written as edits to files in demo-repo/.
// `npm run demo:reference` (scripts/build-demo-reference.ts) applies them and writes
// demo-repo/premise/reference/*.patch.ts and demo-repo/premise/hidden-tests/*.test.ts.
// `npx tsx scripts/check-scenario.ts` then proves they behave as the demo needs.

export interface Edit {
	/** Path inside demo-repo. */
	file: string;
	/** Text that occurs exactly once in the file on trunk. */
	find: string;
	replace: string;
}

export interface Solution {
	/** Name of the generated patch: premise/reference/<id>.patch.ts */
	id: string;
	/** Task id from premise/tasks.json. */
	task: string;
	/** "trunk": written against the original repo. "t01": written after t01 landed (a re-derive). */
	appliesOn: "trunk" | "t01";
	summary: string;
	edits: Edit[];
	/** Acceptance test files (names in demo-solutions/tests/) that the solution adds under tests/. */
	tests: string[];
}

const SESSION_IMPORT_IN_LOGIN = 'import { createSession, revokeSession, SessionExpiredError, type SessionStore, verifySession } from "./session.js";';
const SESSION_IMPORT_IN_HANDLERS = 'import { type Session, SessionExpiredError, type SessionStore, verifySession } from "../auth/session.js";';
const SESSION_IMPORT_IN_RATE_LIMIT = 'import { type Session, SessionExpiredError, type SessionStore, verifySession } from "./session.js";';

const HANDLE_LOGIN_ON_TRUNK = `export function handleLogin(token: string | undefined, deps: LoginDeps): ApiResponse {
	try {
		const session = verifySession(token, deps.store, deps.now);
		if (session === null) {
			return responses.unauthorized();
		}
		record(deps.audit, "session.resumed", deps.now(), session.userId);
		return responses.ok({ userId: session.userId, expiresAt: session.expiresAt });
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return responses.expired();
		}
		throw e;
	}
}`;

const AUTHENTICATE_ON_TRUNK = `export function authenticate(request: ApiRequest, deps: HandlerDeps): AuthResult {
	try {
		const session = verifySession(request.token, deps.sessions, deps.now);
		return session === null ? { kind: "anonymous" } : { kind: "ok", session };
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return { kind: "expired" };
		}
		throw e;
	}
}`;

const GUARD_TAIL_ON_TRUNK = `	try {
		return { allowed: true, session: verifySession(token, deps.sessions, deps.now) };
	} catch (e) {
		if (e instanceof SessionExpiredError) {
			return { allowed: true, session: null };
		}
		throw e;
	}
}`;

export const SOLUTIONS: Solution[] = [
	{
		id: "t01",
		task: "t01-null-expired",
		appliesOn: "trunk",
		summary: "verifySession returns null for an expired session instead of throwing. Signature unchanged.",
		edits: [
			{
				file: "src/auth/session.ts",
				find: "/** Returns null when no token is given. Throws SessionExpiredError when the session is expired. */",
				replace: "/** Returns null when no token is given, the token is unknown, or the session is expired. */",
			},
			{
				file: "src/auth/session.ts",
				find: "	if (isExpired(session, now)) {\n		throw new SessionExpiredError(`session ${session.id} expired`);\n	}\n	return session;",
				replace: "	if (isExpired(session, now)) {\n		return null;\n	}\n	return session;",
			},
		],
		tests: ["session-expiry.test.ts"],
	},
	{
		id: "t02",
		task: "t02-audit-expired",
		appliesOn: "trunk",
		summary: "Audit entry in the catch branch: relies on verifySession throwing.",
		edits: [
			{
				file: "src/auth/login.ts",
				find: "		if (e instanceof SessionExpiredError) {\n			return responses.expired();\n		}",
				replace: '		if (e instanceof SessionExpiredError) {\n			record(deps.audit, "session.expired", deps.now());\n			return responses.expired();\n		}',
			},
		],
		tests: ["audit-expired.test.ts"],
	},
	{
		id: "t02-rederived",
		task: "t02-audit-expired",
		appliesOn: "t01",
		summary: "Same goal after t01: verifySession returns null, so look the token up to tell expired from missing.",
		edits: [
			{
				file: "src/auth/login.ts",
				find: SESSION_IMPORT_IN_LOGIN,
				replace: 'import { createSession, isExpired, revokeSession, type SessionStore, verifySession } from "./session.js";',
			},
			{
				file: "src/auth/login.ts",
				find: HANDLE_LOGIN_ON_TRUNK,
				replace: `export function handleLogin(token: string | undefined, deps: LoginDeps): ApiResponse {
	const session = verifySession(token, deps.store, deps.now);
	if (session === null) {
		// verifySession reports an expired session as null, so look the token up to tell
		// "expired" from "never signed in".
		const stored = token === undefined ? undefined : deps.store.get(token);
		if (stored !== undefined && isExpired(stored, deps.now)) {
			record(deps.audit, "session.expired", deps.now());
			return responses.expired();
		}
		return responses.unauthorized();
	}
	record(deps.audit, "session.resumed", deps.now(), session.userId);
	return responses.ok({ userId: session.userId, expiresAt: session.expiresAt });
}`,
			},
		],
		tests: ["audit-expired.test.ts"],
	},
	{
		id: "t03",
		task: "t03-expired-metrics",
		appliesOn: "trunk",
		summary: "Counter in the catch branch: relies on verifySession throwing.",
		edits: [
			{
				file: "src/api/handlers.ts",
				find: '		if (e instanceof SessionExpiredError) {\n			return { kind: "expired" };\n		}',
				replace: '		if (e instanceof SessionExpiredError) {\n			increment(deps.metrics, "sessionsExpired");\n			return { kind: "expired" };\n		}',
			},
		],
		tests: ["expired-metrics.test.ts"],
	},
	{
		id: "t03-rederived",
		task: "t03-expired-metrics",
		appliesOn: "t01",
		summary: "Same goal after t01: detect expiry from the stored session.",
		edits: [
			{
				file: "src/api/handlers.ts",
				find: SESSION_IMPORT_IN_HANDLERS,
				replace: 'import { isExpired, type Session, type SessionStore, verifySession } from "../auth/session.js";',
			},
			{
				file: "src/api/handlers.ts",
				find: AUTHENTICATE_ON_TRUNK,
				replace: `export function authenticate(request: ApiRequest, deps: HandlerDeps): AuthResult {
	const session = verifySession(request.token, deps.sessions, deps.now);
	if (session !== null) {
		return { kind: "ok", session };
	}
	// verifySession reports an expired session as null, so check the stored session ourselves.
	const stored = request.token === undefined ? undefined : deps.sessions.get(request.token);
	if (stored !== undefined && isExpired(stored, deps.now)) {
		increment(deps.metrics, "sessionsExpired");
		return { kind: "expired" };
	}
	return { kind: "anonymous" };
}`,
			},
		],
		tests: ["expired-metrics.test.ts"],
	},
	{
		id: "t11",
		task: "t11-expired-rate-limit",
		appliesOn: "trunk",
		summary: "Limiter hit in the catch branch: relies on verifySession throwing.",
		edits: [
			{
				file: "src/auth/rate-limit.ts",
				find: "		if (e instanceof SessionExpiredError) {\n			return { allowed: true, session: null };\n		}",
				replace: "		if (e instanceof SessionExpiredError) {\n			deps.limiter.hit(clientKey, deps.now());\n			return { allowed: true, session: null };\n		}",
			},
		],
		tests: ["expired-rate-limit.test.ts"],
	},
	{
		id: "t11-rederived",
		task: "t11-expired-rate-limit",
		appliesOn: "t01",
		summary: "Same goal after t01: detect expiry from the stored session.",
		edits: [
			{
				file: "src/auth/rate-limit.ts",
				find: SESSION_IMPORT_IN_RATE_LIMIT,
				replace: 'import { isExpired, type Session, type SessionStore, verifySession } from "./session.js";',
			},
			{
				file: "src/auth/rate-limit.ts",
				find: GUARD_TAIL_ON_TRUNK,
				replace: `	const session = verifySession(token, deps.sessions, deps.now);
	if (session === null && token !== undefined) {
		// verifySession reports an expired session as null, so check the stored session ourselves.
		const stored = deps.sessions.get(token);
		if (stored !== undefined && isExpired(stored, deps.now)) {
			deps.limiter.hit(clientKey, deps.now());
		}
	}
	return { allowed: true, session };
}`,
			},
		],
		tests: ["expired-rate-limit.test.ts"],
	},
	{
		id: "t04",
		task: "t04-session-ttl-header",
		appliesOn: "trunk",
		summary: "Uses the Session type and sessionTtl only, so it is unaffected by t01.",
		edits: [
			{
				file: "src/api/responses.ts",
				find: 'import type { Session } from "../auth/session.js";',
				replace: 'import { type Session, sessionTtl } from "../auth/session.js";',
			},
			{
				file: "src/api/responses.ts",
				find: '			"x-session-user": session.userId,\n',
				replace: '			"x-session-user": session.userId,\n			"x-session-ttl": String(Math.floor(sessionTtl(session, now) / 1000)),\n',
			},
		],
		tests: ["session-ttl-header.test.ts"],
	},
	{
		id: "t05",
		task: "t05-tax-rounding",
		appliesOn: "trunk",
		summary: "taxFor rounds half to even; computeTotal uses taxFor.",
		edits: [
			{
				file: "src/billing/tax.ts",
				find: "/** Tax on `amount` minor units at `rateBps`, rounded half up to a whole minor unit. */\nexport function taxFor(amount: number, rateBps: number): number {\n	return Math.floor((amount * rateBps + BASIS_POINTS / 2) / BASIS_POINTS);\n}",
				replace: `/** Tax on \`amount\` minor units at \`rateBps\`, rounded half to even to a whole minor unit. */
export function taxFor(amount: number, rateBps: number): number {
	const scaled = amount * rateBps;
	const whole = Math.floor(scaled / BASIS_POINTS);
	const remainder = scaled - whole * BASIS_POINTS;
	const roundUp = remainder * 2 > BASIS_POINTS || (remainder * 2 === BASIS_POINTS && whole % 2 === 1);
	return roundUp ? whole + 1 : whole;
}`,
			},
			{
				file: "src/billing/invoice.ts",
				find: 'import { BASIS_POINTS, type Region, taxRateFor } from "./tax.js";',
				replace: 'import { type Region, taxFor, taxRateFor } from "./tax.js";',
			},
			{
				file: "src/billing/invoice.ts",
				find: "	const tax = Math.round((taxable * taxRateFor(invoice.region)) / BASIS_POINTS);",
				replace: "	const tax = taxFor(taxable, taxRateFor(invoice.region));",
			},
		],
		tests: ["tax-rounding.test.ts"],
	},
	{
		id: "t06",
		task: "t06-discount-stacking",
		appliesOn: "trunk",
		summary: "applyDiscounts takes the largest percentage and the largest fixed discount only.",
		edits: [
			{
				file: "src/billing/discount.ts",
				find: `/**
 * The total taken off \`subtotal\` by \`discounts\`, applied one after another in the order given.
 * Each discount works on what is left after the ones before it.
 */
export function applyDiscounts(subtotal: number, discounts: readonly Discount[]): number {
	let remaining = subtotal;
	for (const discount of discounts) {
		remaining -= discountAmount(remaining, discount);
	}
	return subtotal - remaining;
}`,
				replace: `/**
 * The total taken off \`subtotal\`: the largest percentage discount first, then the largest fixed
 * discount on what is left. Any other discounts are ignored, so codes cannot be stacked.
 */
export function applyDiscounts(subtotal: number, discounts: readonly Discount[]): number {
	const percents = discounts.filter(isPercent).sort((a, b) => b.percent - a.percent);
	const fixed = discounts.filter((discount) => !isPercent(discount)).sort((a, b) => discountAmount(subtotal, b) - discountAmount(subtotal, a));
	let remaining = subtotal;
	for (const discount of [percents[0], fixed[0]]) {
		if (discount !== undefined) {
			remaining -= discountAmount(remaining, discount);
		}
	}
	return subtotal - remaining;
}`,
			},
		],
		tests: ["discount-stacking.test.ts"],
	},
	{
		id: "t07",
		task: "t07-role-check",
		appliesOn: "trunk",
		summary: "Adds canAccess and the resource-to-minimum-role table.",
		edits: [
			{
				file: "src/users/roles.ts",
				find: "/** Adds a role. The result is de-duplicated and ordered by rank. */",
				replace: `export type Resource = "profile" | "invoices" | "billing" | "members";

/** The least privileged role that may open each resource. */
export const RESOURCE_MINIMUM: Record<Resource, Role> = {
	profile: "viewer",
	invoices: "member",
	billing: "billing",
	members: "admin",
};

/** True when any of \`roles\` may open \`resource\`. */
export function canAccess(roles: readonly Role[], resource: Resource): boolean {
	return isAtLeast(roles, RESOURCE_MINIMUM[resource]);
}

/** Adds a role. The result is de-duplicated and ordered by rank. */`,
			},
		],
		tests: ["can-access.test.ts"],
	},
	{
		id: "t08",
		task: "t08-profile-validation",
		appliesOn: "trunk",
		summary: "validateProfile rejects display names longer than 64 visible characters.",
		edits: [
			{
				file: "src/users/profile.ts",
				find: "export const MAX_BIO_LENGTH = 280;",
				replace: "export const MAX_BIO_LENGTH = 280;\nexport const MAX_DISPLAY_NAME_LENGTH = 64;",
			},
			{
				file: "src/users/profile.ts",
				find: "	if (update.bio !== undefined && visibleLength(update.bio) > MAX_BIO_LENGTH) {",
				replace: "	if (update.displayName !== undefined && visibleLength(update.displayName) > MAX_DISPLAY_NAME_LENGTH) {\n		problems.push({ field: \"displayName\", message: `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.` });\n	}\n	if (update.bio !== undefined && visibleLength(update.bio) > MAX_BIO_LENGTH) {",
			},
		],
		tests: ["display-name-length.test.ts"],
	},
	{
		id: "t09",
		task: "t09-currency-format",
		appliesOn: "trunk",
		summary: "formatMoney uses each currency's own number of decimals.",
		edits: [
			{
				file: "src/billing/currency.ts",
				find: "/** `$12.50`, `-€3.00`. */\nexport function formatMoney(value: Money): string {\n	const sign = value.amount < 0 ? \"-\" : \"\";\n	const major = Math.abs(value.amount) / 100;\n	return `${sign}${CURRENCIES[value.currency].symbol}${major.toFixed(2)}`;\n}",
				replace: "/** `$12.50`, `-€3.00`, `¥1200`. */\nexport function formatMoney(value: Money): string {\n	const sign = value.amount < 0 ? \"-\" : \"\";\n	const { symbol, decimals } = CURRENCIES[value.currency];\n	const major = Math.abs(value.amount) / minorUnits(value.currency);\n	return `${sign}${symbol}${major.toFixed(decimals)}`;\n}",
			},
		],
		tests: ["currency-format.test.ts"],
	},
	{
		id: "t10",
		task: "t10-invoice-numbering",
		appliesOn: "trunk",
		summary: "nextInvoiceNumber restarts at 0001 when the year changes.",
		edits: [
			{
				file: "src/billing/invoice.ts",
				find: `/**
 * The number after \`previous\`, stamped with the year of \`issuedAt\`: INV-2026-0041 -> INV-2026-0042.
 * With no previous number, numbering starts at 0001.
 */
export function nextInvoiceNumber(previous: string | undefined, issuedAt: number): string {
	const lastSequence = previous === undefined ? 0 : Number(previous.split("-")[2] ?? 0);
	return \`\${INVOICE_PREFIX}-\${yearOf(issuedAt)}-\${padLeft(lastSequence + 1, 4)}\`;
}`,
				replace: `/**
 * The number after \`previous\`, stamped with the year of \`issuedAt\`: INV-2026-0041 -> INV-2026-0042.
 * Numbering starts at 0001, and starts again at 0001 in each new calendar year.
 */
export function nextInvoiceNumber(previous: string | undefined, issuedAt: number): string {
	const year = yearOf(issuedAt);
	const [, previousYear, previousSequence] = previous?.split("-") ?? [];
	const lastSequence = Number(previousYear) === year ? Number(previousSequence ?? 0) : 0;
	return \`\${INVOICE_PREFIX}-\${year}-\${padLeft(lastSequence + 1, 4)}\`;
}`,
			},
		],
		tests: ["invoice-numbering.test.ts"],
	},
	{
		id: "t12",
		task: "t12-password-policy",
		appliesOn: "trunk",
		summary: "checkPasswordPolicy enforces requireDigit, which is now on by default.",
		edits: [
			{
				file: "src/auth/password.ts",
				find: "	/** Require at least one digit. Declared for configuration files; not enforced yet. */",
				replace: "	/** Require at least one digit. */",
			},
			{
				file: "src/auth/password.ts",
				find: "	requireDigit: false,\n};",
				replace: "	requireDigit: true,\n};",
			},
			{
				file: "src/auth/password.ts",
				find: '	if (/\\s/.test(password)) {\n		issues.push("has_whitespace");\n	}',
				replace: '	if (policy.requireDigit && !/[0-9]/.test(password)) {\n		issues.push("needs_digit");\n	}\n	if (/\\s/.test(password)) {\n		issues.push("has_whitespace");\n	}',
			},
		],
		tests: ["password-digit.test.ts"],
	},
];
