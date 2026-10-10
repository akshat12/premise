// Runs right after the TypeScript compiler module has been evaluated. Restores `process.browser`
// so that no other library sees the temporary value set in ./before.ts.
import { hadBrowserFlag, previousBrowserFlag } from "./before";

type ProcessLike = { browser?: boolean };
const proc = (globalThis as { process?: ProcessLike }).process;

if (proc !== undefined) {
	if (hadBrowserFlag) {
		proc.browser = previousBrowserFlag;
	} else {
		delete proc.browser;
	}
}
