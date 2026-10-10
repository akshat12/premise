// Runs before the TypeScript compiler module is evaluated (see ./index.ts).
//
// On load, the compiler asks "am I in Node?" by looking for `process.nextTick`, `require` and the
// absence of `process.browser`. Under nodejs_compat a Worker looks enough like Node to say yes,
// and the compiler then builds its Node "system" object: it calls into `os`, `fs` and
// `__filename`, which fails or crashes depending on how the code was bundled. We never use that
// object (every program gets an in-memory host), so say "browser" for the instant the compiler
// loads. `./after.ts` puts the flag back.
type ProcessLike = { browser?: boolean };
const proc = (globalThis as { process?: ProcessLike }).process;

export const hadBrowserFlag = proc !== undefined && Object.prototype.hasOwnProperty.call(proc, "browser");
export const previousBrowserFlag = proc?.browser;

if (proc !== undefined) {
	proc.browser = true;
}
