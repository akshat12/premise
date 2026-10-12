// Letting go of RPC stubs. Pure apart from the call it makes.

/**
 * Releases RPC stubs that are done with: a Workflow instance handle, a Dynamic Worker and its
 * entrypoint. The runtime warns about a stub left for the garbage collector ("An RPC stub was not
 * disposed properly"), and the local runtime has been seen to crash while logging that warning.
 * Anything that is not a stub, or is already gone, is passed over.
 */
export function release(...stubs: unknown[]): void {
	for (const stub of stubs.flat()) {
		try {
			(stub as Partial<Disposable> | null | undefined)?.[Symbol.dispose]?.();
		} catch {
			// Already released, or never a stub.
		}
	}
}
