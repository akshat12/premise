// Errors as values across Durable Object RPC.
//
// When a Durable Object method throws, the caller does get the rejection, but the error class is
// lost on the way, and under the test runner the same rejection is also reported as unhandled
// inside the object. So objects whose methods can fail in expected ways answer with a result
// value instead, and the client turns a failure back into a thrown error of the right class.

export interface RpcError {
	name: string;
	message: string;
	/** The error's own enumerable fields (for example `from` and `action` on IllegalTransition). */
	data: Record<string, unknown>;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

/** Runs `fn` and captures what it throws. */
export async function capture<T>(fn: () => T | Promise<T>): Promise<RpcResult<T>> {
	try {
		return { ok: true, value: await fn() };
	} catch (thrown) {
		if (thrown instanceof Error) {
			return { ok: false, error: { name: thrown.name, message: thrown.message, data: { ...thrown } } };
		}
		return { ok: false, error: { name: "Error", message: String(thrown), data: {} } };
	}
}

/** Rebuilds a specific error class from its captured form, or returns undefined to get a plain Error. */
export type Reviver = (error: RpcError) => Error | undefined;

/** Returns the value, or throws the captured error. */
export function unwrap<T>(result: RpcResult<T>, revive?: Reviver): T {
	if (result.ok) {
		return result.value;
	}
	const revived = revive?.(result.error);
	if (revived !== undefined) {
		throw revived;
	}
	const error = new Error(result.error.message);
	error.name = result.error.name;
	throw Object.assign(error, result.error.data);
}

/**
 * A client object for a Durable Object that exposes one RPC method, `rpc(method, args)`,
 * returning an RpcResult. `methods` is the complete list of method names the client may call.
 */
export function rpcClient<Api extends object>(stub: unknown, methods: readonly (keyof Api & string)[], revive?: Reviver): Api {
	const target = stub as { rpc(method: string, args: unknown[]): Promise<RpcResult<unknown>> };
	const client: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
	for (const method of methods) {
		client[method] = async (...args) => unwrap(await target.rpc(method, args), revive);
	}
	return client as unknown as Api;
}
