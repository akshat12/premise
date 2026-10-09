export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface Route {
	name: string;
	method: Method;
	/** Path with `:name` segments for parameters, e.g. `/invoices/:id`. */
	pattern: string;
	/** Whether the caller must be signed in. */
	auth: boolean;
}

export const ROUTES: readonly Route[] = [
	{ name: "session.resume", method: "GET", pattern: "/session", auth: false },
	{ name: "profile.get", method: "GET", pattern: "/profile", auth: true },
	{ name: "profile.update", method: "PUT", pattern: "/profile", auth: true },
	{ name: "invoices.list", method: "GET", pattern: "/invoices", auth: true },
	{ name: "invoices.get", method: "GET", pattern: "/invoices/:id", auth: true },
];

export interface RouteMatch {
	route: Route;
	params: Record<string, string>;
}

function segments(path: string): string[] {
	return (path.split("?")[0] ?? "").split("/").filter((part) => part !== "");
}

/** Matches a path against one pattern and extracts its parameters. Null when it does not fit. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
	const want = segments(pattern);
	const got = segments(path);
	if (want.length !== got.length) {
		return null;
	}
	const params: Record<string, string> = {};
	for (let i = 0; i < want.length; i++) {
		const expected = want[i] as string;
		const actual = got[i] as string;
		if (expected.startsWith(":")) {
			params[expected.slice(1)] = decodeURIComponent(actual);
		} else if (expected !== actual) {
			return null;
		}
	}
	return params;
}

export function matchRoute(method: Method, path: string, routes: readonly Route[] = ROUTES): RouteMatch | null {
	for (const route of routes) {
		if (route.method !== method) {
			continue;
		}
		const params = matchPattern(route.pattern, path);
		if (params !== null) {
			return { route, params };
		}
	}
	return null;
}

export function routeKey(route: Pick<Route, "method" | "pattern">): string {
	return `${route.method} ${route.pattern}`;
}

/** The methods that some route accepts for this path. Empty when no route matches at all. */
export function allowedMethods(path: string, routes: readonly Route[] = ROUTES): Method[] {
	return routes.filter((route) => matchPattern(route.pattern, path) !== null).map((route) => route.method);
}
