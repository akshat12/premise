// demo-repo/ bundled into the Worker as text, so REPO_STORE=memory can start with a real trunk.
// Vite inlines the files at build time; nothing is read from disk at runtime.
import type { FileMap } from "./repo-store";

const PREFIX = "/demo-repo/";

const modules = import.meta.glob<string>(["/demo-repo/**/*.{ts,json,md}", "!**/node_modules/**"], {
	query: "?raw",
	import: "default",
	eager: true,
});

/** Every text file in demo-repo/, keyed by its path inside that repo. */
export const DEMO_REPO_FILES: FileMap = Object.fromEntries(
	Object.entries(modules)
		.map(([path, text]): [string, string] => [path.slice(PREFIX.length), text])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
