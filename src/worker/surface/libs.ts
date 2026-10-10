// The TypeScript lib .d.ts files needed for `lib: ["es2022"]`, bundled as text so the compiler
// can run with no filesystem. Vite inlines them from the installed `typescript` package at build
// time, so they always match the compiler version. (T00 used a generated file for the same job.)
const PREFIX = "/node_modules/typescript/lib/";

const modules = import.meta.glob<string>(
	[
		"/node_modules/typescript/lib/lib.es5.d.ts",
		"/node_modules/typescript/lib/lib.es20{15,16,17,18,19,20,21,22}*.d.ts",
		"/node_modules/typescript/lib/lib.decorators*.d.ts",
		// The `.full` variants pull in the DOM libs, which the repos we check do not use.
		"!/node_modules/typescript/lib/*.full.d.ts",
	],
	{ query: "?raw", import: "default", eager: true },
);

/** lib file name (e.g. "lib.es2022.d.ts") -> its text. */
export const TS_LIBS: Record<string, string> = Object.fromEntries(Object.entries(modules).map(([path, text]) => [path.slice(PREFIX.length), text]));

export const DEFAULT_LIB = "lib.es2022.d.ts";
