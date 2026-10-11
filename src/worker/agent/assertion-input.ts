// Tidies the code a model gives assert_premise. Pure.
//
// An assertion's code is the body of a function: it may not contain import statements, and the
// exports of the files listed in `imports` are already in scope by name. Models write imports
// anyway, in every form (`import { a } from`, `import * as ns from`, `await import(...)`), with
// paths relative to wherever they imagine the code lives. Rejecting that costs a turn each time
// and teaches nothing, so the imports are read for what they mean: the file goes into `imports`,
// and the statement is removed (or, for a namespace, replaced by an object of that file's exports).
import type { FileMap } from "../ports/repo-store";
import { indexFile } from "../symbols";

/** The repo file a specifier means: the one whose path ends with it, once `./`, `../` and the extension are set aside. Null if none or several do. */
export function resolveLoosely(specifier: string, files: FileMap): string | null {
	const bare = specifier
		.replace(/^(\.{1,2}\/)+/, "")
		.replace(/^\/+/, "")
		.replace(/\.(js|ts)$/, "");
	if (bare === "") {
		return null;
	}
	const candidates = Object.keys(files).filter((path) => path.endsWith(".ts") && (path === `${bare}.ts` || path.endsWith(`/${bare}.ts`)));
	const exact = candidates.find((path) => path === `${bare}.ts`);
	return exact ?? (candidates.length === 1 ? (candidates[0] as string) : null);
}

const valueNames = (path: string, files: FileMap): string[] =>
	indexFile(path, files[path] ?? "")
		.filter((symbol) => symbol.kind !== "interface" && symbol.kind !== "type" && symbol.name !== "default")
		.map((symbol) => symbol.name);

const STATIC_IMPORT = /^[ \t]*import\s+(?:type\s+)?(?:(\*\s+as\s+([A-Za-z_$][\w$]*))|[^"';]*?)\s*from\s*["']([^"']+)["'];?[ \t]*$/gm;
const SIDE_EFFECT_IMPORT = /^[ \t]*import\s*["']([^"']+)["'];?[ \t]*$/gm;
const DYNAMIC_DESTRUCTURED = /^[ \t]*(?:const|let|var)\s*\{[^}]*\}\s*=\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)\s*;?[ \t]*$/gm;
const DYNAMIC_NAMESPACE = /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)\s*;?[ \t]*$/gm;

/**
 * The functions from `imports` that the code calls. A check that calls none of them would pass
 * whatever they do (`assert.throws(() => { throw new E(); }, E)` is the usual one), so it says
 * nothing about the code and is not accepted as a premise.
 */
export function functionsCalled(code: string, imports: readonly string[], files: FileMap): string[] {
	const functions = imports.flatMap((path) => indexFile(path, files[path] ?? "")).filter((symbol) => symbol.kind === "function");
	return [...new Set(functions.filter((symbol) => new RegExp(`(^|[^A-Za-z0-9_$])${symbol.name}\\s*\\(`).test(code)).map((symbol) => symbol.name))];
}

export interface TidyAssertion {
	code: string;
	imports: string[];
	/** Specifiers the code imported that match no file in the repo. */
	unknown: string[];
}

/** Removes import statements from assertion code, adding the files they name to `imports`. */
export function tidyAssertion(code: string, imports: readonly string[], files: FileMap): TidyAssertion {
	const found: string[] = [];
	const unknown: string[] = [];
	const note = (specifier: string): string | null => {
		const path = resolveLoosely(specifier, files);
		(path === null ? unknown : found).push(path ?? specifier);
		return path;
	};
	const namespace = (name: string, specifier: string): string => {
		const path = note(specifier);
		return path === null ? "" : `const ${name} = { ${valueNames(path, files).join(", ")} };`;
	};
	const tidied = code
		.replace(STATIC_IMPORT, (_match, star: string | undefined, name: string | undefined, specifier: string) => (star !== undefined && name !== undefined ? namespace(name, specifier) : (note(specifier), "")))
		.replace(SIDE_EFFECT_IMPORT, (_match, specifier: string) => (note(specifier), ""))
		.replace(DYNAMIC_DESTRUCTURED, (_match, specifier: string) => (note(specifier), ""))
		.replace(DYNAMIC_NAMESPACE, (_match, name: string, specifier: string) => namespace(name, specifier));
	return { code: tidied.replace(/^\s*\n/, ""), imports: [...new Set([...imports, ...found])], unknown: [...new Set(unknown)] };
}
