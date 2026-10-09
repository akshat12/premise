/** Compares two strings without returning early on the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

/**
 * True when the request carries the admin token in `x-admin-token`.
 * Fails closed: with no ADMIN_TOKEN configured, nothing is authorised.
 */
export function isAdminRequest(request: Request, env: { ADMIN_TOKEN?: string }): boolean {
	const expected = env.ADMIN_TOKEN;
	const given = request.headers.get("x-admin-token");
	if (!expected || !given) {
		return false;
	}
	return constantTimeEqual(given, expected);
}
