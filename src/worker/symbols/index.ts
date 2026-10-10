// Symbol index: which exported symbols a file has, which of them an edit touched, and which
// symbols a piece of code refers to. Uses the TypeScript parser only (no Program, no type
// information), so it is fast and has no dependencies between files.
import ts from "typescript";
import { symbolId } from "../../shared/ids";
import type { SymbolId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";

export interface SymbolInfo {
	id: SymbolId; // "src/auth/session.ts#verifySession"
	name: string;
	kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "let" | "var";
	startLine: number; // 1-based, inclusive, covers JSDoc + declaration
	endLine: number;
	/**
	 * Last line of the "interface part". For a function or class it is the line with the opening
	 * "{" of the body. For interfaces, types, enums and plain consts it is `endLine`: the whole
	 * declaration is interface. A const whose value is a function with a block body is treated
	 * like a function, so editing that body is a body touch.
	 */
	signatureEndLine: number;
}

export interface LineChange {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
} // 1-based inclusive; empty range = start > end

export interface Touch {
	symbol: SymbolId;
	part: "body" | "interface";
}

interface Declaration {
	name: string;
	kind: SymbolInfo["kind"];
	exported: boolean;
	isDefault: boolean;
	startLine: number;
	endLine: number;
	signatureEndLine: number;
}

function parse(path: string, text: string): ts.SourceFile {
	return ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** Every named top-level declaration in a file, exported or not, with its line ranges. */
function declarations(sf: ts.SourceFile): Declaration[] {
	const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
	const out: Declaration[] = [];

	const add = (node: ts.Node, name: string, kind: SymbolInfo["kind"], signatureEnd: number | undefined) => {
		const endLine = line(node.getEnd());
		out.push({
			name,
			kind,
			exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
			isDefault: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
			// getStart(sf, true) includes the JSDoc comment, which is part of what an agent reads.
			startLine: line(node.getStart(sf, true)),
			endLine,
			signatureEndLine: signatureEnd === undefined ? endLine : Math.min(line(signatureEnd), endLine),
		});
	};

	for (const statement of sf.statements) {
		if (ts.isFunctionDeclaration(statement)) {
			add(statement, statement.name?.text ?? "default", "function", statement.body?.getStart(sf));
		} else if (ts.isClassDeclaration(statement)) {
			// `members.pos` is the position just after the opening "{".
			add(statement, statement.name?.text ?? "default", "class", statement.members.pos - 1);
		} else if (ts.isInterfaceDeclaration(statement)) {
			add(statement, statement.name.text, "interface", undefined);
		} else if (ts.isTypeAliasDeclaration(statement)) {
			add(statement, statement.name.text, "type", undefined);
		} else if (ts.isEnumDeclaration(statement)) {
			add(statement, statement.name.text, "enum", undefined);
		} else if (ts.isVariableStatement(statement)) {
			const flags = statement.declarationList.flags;
			const kind = flags & ts.NodeFlags.Const ? "const" : flags & ts.NodeFlags.Let ? "let" : "var";
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) {
					continue; // destructuring at the top level: not a nameable symbol
				}
				const value = declaration.initializer;
				const body = value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) && ts.isBlock(value.body) ? value.body : undefined;
				add(statement, declaration.name.text, kind, body?.getStart(sf));
			}
		}
	}
	return out;
}

/** `export { a, b as c }` lists that name local declarations: exported name -> local name. */
function exportLists(sf: ts.SourceFile): Map<string, string> {
	const names = new Map<string, string>();
	for (const statement of sf.statements) {
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				names.set(element.name.text, (element.propertyName ?? element.name).text);
			}
		}
	}
	return names;
}

function toInfo(path: string, declaration: Declaration, name: string): SymbolInfo {
	return {
		id: symbolId(path, name),
		name,
		kind: declaration.kind,
		startLine: declaration.startLine,
		endLine: declaration.endLine,
		signatureEndLine: declaration.signatureEndLine,
	};
}

function indexParsed(path: string, sf: ts.SourceFile): { exported: SymbolInfo[]; helpers: Declaration[] } {
	const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
	const all = declarations(sf);
	const listed = exportLists(sf);
	const exported: SymbolInfo[] = [];
	const exportedLocals = new Set<string>();

	for (const declaration of all) {
		if (declaration.exported) {
			exported.push(toInfo(path, declaration, declaration.isDefault ? "default" : declaration.name));
			exportedLocals.add(declaration.name);
		}
	}
	for (const [exportedName, localName] of listed) {
		const declaration = all.find((candidate) => candidate.name === localName);
		if (declaration !== undefined) {
			exported.push(toInfo(path, declaration, exportedName));
			exportedLocals.add(localName);
		}
	}
	// `export default <expression>;`
	for (const statement of sf.statements) {
		if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
			const endLine = line(statement.getEnd());
			exported.push({ id: symbolId(path, "default"), name: "default", kind: "const", startLine: line(statement.getStart(sf, true)), endLine, signatureEndLine: endLine });
		}
	}

	const seen = new Set<string>();
	const unique = exported.filter((info) => (seen.has(info.id) ? false : (seen.add(info.id), true)));
	return { exported: unique, helpers: all.filter((declaration) => !exportedLocals.has(declaration.name)) };
}

/** The exported symbols of one file, in source order. */
export function indexFile(path: string, text: string): SymbolInfo[] {
	return indexParsed(path, parse(path, text)).exported;
}

/** Source files that hold symbols: `*.ts`, but not declaration files, tests or Premise's own files. */
export function isIndexedPath(path: string): boolean {
	return path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.startsWith("tests/") && !path.startsWith("premise/");
}

/** Every exported symbol in the repo. Only *.ts; skips tests/ and premise/. */
export function indexRepo(files: FileMap): Map<SymbolId, SymbolInfo> {
	const index = new Map<SymbolId, SymbolInfo>();
	for (const path of Object.keys(files).filter(isIndexedPath).sort()) {
		for (const info of indexFile(path, files[path] ?? "")) {
			index.set(info.id, info);
		}
	}
	return index;
}

function splitLines(text: string): string[] {
	const lines = text.split("\n");
	// A trailing newline does not start another line.
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

const squash = (line: string) => line.replace(/\s+/g, " ").trim();

/**
 * Line-level diff (longest common subsequence). Lines that differ only in whitespace count as
 * equal, and a change made only of blank lines is dropped, so reformatting is not reported.
 * Fine for files under about 2,000 lines.
 */
export function lineDiff(oldText: string, newText: string): LineChange[] {
	const a = splitLines(oldText).map(squash);
	const b = splitLines(newText).map(squash);

	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	const n = a.length - prefix - suffix;
	const m = b.length - prefix - suffix;

	// lcs[i][j] = length of the LCS of a[prefix+i..] and b[prefix+j..], stored row-major.
	const width = m + 1;
	const lcs = new Uint16Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i * width + j] =
				a[prefix + i] === b[prefix + j]
					? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
					: Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
		}
	}

	const changes: LineChange[] = [];
	let i = 0;
	let j = 0;
	let open: LineChange | null = null;
	const close = () => {
		if (open !== null) {
			open.oldEnd = prefix + i;
			open.newEnd = prefix + j;
			changes.push(open);
			open = null;
		}
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
			close();
			i++;
			j++;
			continue;
		}
		open ??= { oldStart: prefix + i + 1, oldEnd: 0, newStart: prefix + j + 1, newEnd: 0 };
		if (j < m && (i === n || (lcs[i * width + j + 1] ?? 0) >= (lcs[(i + 1) * width + j] ?? 0))) {
			j++;
		} else {
			i++;
		}
	}
	close();

	const blank = (lines: string[], start: number, end: number) => lines.slice(start - 1, end).every((line) => line === "");
	return changes.filter((change) => !(blank(a, change.oldStart, change.oldEnd) && blank(b, change.newStart, change.newEnd)));
}

function overlaps(start: number, end: number, from: number, to: number): boolean {
	return start <= end && from <= to && start <= to && from <= end;
}

function usesName(lines: string[], info: { startLine: number; endLine: number }, name: string): boolean {
	const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${name.replace(/[$]/g, "\\$")}([^A-Za-z0-9_$]|$)`);
	return lines.slice(info.startLine - 1, info.endLine).some((line) => pattern.test(line));
}

/**
 * Which exported symbols did this edit touch, and did it touch the interface part or only the
 * body? A new export is an interface touch on the new symbol; so is a removed export.
 *
 * A JSDoc-only change counts as an interface touch: the comment is part of what an agent reads
 * to decide how to use a symbol. (The type-surface hash in T07 ignores comments; that is the
 * stricter check used for premises.)
 */
export function touchedSymbols(path: string, oldText: string | null, newText: string | null): Touch[] {
	const before = oldText === null ? null : indexParsed(path, parse(path, oldText));
	const after = newText === null ? null : indexParsed(path, parse(path, newText));
	const touches = new Map<SymbolId, Touch["part"]>();
	const mark = (symbol: SymbolId, part: Touch["part"]) => {
		if (part === "interface" || !touches.has(symbol)) {
			touches.set(symbol, part);
		}
	};

	const oldById = new Map((before?.exported ?? []).map((info) => [info.id, info]));
	const newById = new Map((after?.exported ?? []).map((info) => [info.id, info]));
	for (const id of new Set([...oldById.keys(), ...newById.keys()])) {
		if (!oldById.has(id) || !newById.has(id)) {
			mark(id, "interface");
		}
	}

	if (before !== null && after !== null && oldText !== null && newText !== null) {
		const changes = lineDiff(oldText, newText);
		const oldLines = splitLines(oldText);
		const newLines = splitLines(newText);
		const hit = (side: "old" | "new", from: number, to: number) =>
			changes.some((change) => (side === "old" ? overlaps(change.oldStart, change.oldEnd, from, to) : overlaps(change.newStart, change.newEnd, from, to)));

		for (const [id, was] of oldById) {
			const now = newById.get(id);
			if (now === undefined) {
				continue;
			}
			if (hit("old", was.startLine, was.signatureEndLine) || hit("new", now.startLine, now.signatureEndLine)) {
				mark(id, "interface");
			} else if (hit("old", was.signatureEndLine + 1, was.endLine) || hit("new", now.signatureEndLine + 1, now.endLine)) {
				mark(id, "body");
			}
		}

		// A changed private helper is a body touch on every exported symbol that uses it, directly
		// or through other helpers.
		const changedHelpers = new Set<string>();
		const oldHelpers = new Map(before.helpers.map((helper) => [helper.name, helper]));
		const newHelpers = new Map(after.helpers.map((helper) => [helper.name, helper]));
		for (const name of new Set([...oldHelpers.keys(), ...newHelpers.keys()])) {
			const was = oldHelpers.get(name);
			const now = newHelpers.get(name);
			if (was === undefined || now === undefined || hit("old", was.startLine, was.endLine) || hit("new", now.startLine, now.endLine)) {
				changedHelpers.add(name);
			}
		}
		for (let grew = true; grew; ) {
			grew = false;
			for (const [name, helper] of newHelpers) {
				if (!changedHelpers.has(name) && [...changedHelpers].some((changed) => usesName(newLines, helper, changed))) {
					changedHelpers.add(name);
					grew = true;
				}
			}
		}
		for (const helper of changedHelpers) {
			for (const [id, now] of newById) {
				const was = oldById.get(id);
				if (usesName(newLines, now, helper) || (was !== undefined && usesName(oldLines, was, helper))) {
					mark(id, "body");
				}
			}
		}
	}

	return [...touches.entries()].map(([symbol, part]) => ({ symbol, part })).sort((x, y) => (x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0));
}

/** Resolves "./x", "../y/z.js" from `fromPath` to a repo path ending in ".ts". Null for package imports. */
export function resolveImport(fromPath: string, specifier: string): string | null {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return null;
	}
	const parts = fromPath.split("/").slice(0, -1);
	for (const part of specifier.split("/")) {
		if (part === "..") {
			parts.pop();
		} else if (part !== "." && part !== "") {
			parts.push(part);
		}
	}
	const joined = parts.join("/");
	if (joined.endsWith(".ts")) {
		return joined;
	}
	return `${joined.replace(/\.js$/, "")}.ts`;
}

interface Imports {
	named: Map<string, SymbolId>;
	/** `import * as ns from "./x.js"`: local namespace name -> repo path. */
	namespaces: Map<string, string>;
}

function readImports(path: string, sf: ts.SourceFile): Imports {
	const named = new Map<string, SymbolId>();
	const namespaces = new Map<string, string>();
	for (const statement of sf.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		const target = resolveImport(path, statement.moduleSpecifier.text);
		const clause = statement.importClause;
		if (target === null || clause === undefined) {
			continue;
		}
		if (clause.name !== undefined) {
			named.set(clause.name.text, symbolId(target, "default"));
		}
		if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
			for (const element of clause.namedBindings.elements) {
				named.set(element.name.text, symbolId(target, (element.propertyName ?? element.name).text));
			}
		} else if (clause.namedBindings !== undefined) {
			namespaces.set(clause.namedBindings.name.text, target);
		}
	}
	return { named, namespaces };
}

/**
 * Imported names -> SymbolIds, resolving relative imports ("./x", "../y/z") to repo paths with
 * ".ts". Ignores package imports. Namespace imports (`import * as ns`) have no single symbol, so
 * they are not in this map; `referencedSymbols` resolves `ns.name` uses.
 */
export function importMap(path: string, text: string): Map<string, SymbolId> {
	return readImports(path, parse(path, text)).named;
}

/** True when this identifier is the name being declared, or a property name, rather than a use. */
function isNotAReference(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
		return true;
	}
	if (ts.isQualifiedName(parent) && parent.right === node) {
		return true;
	}
	if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent)) && parent.name === node) {
		return true;
	}
	const declared = (parent as { name?: ts.Node }).name;
	return (
		declared === node &&
		(ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isTypeParameterDeclaration(parent))
	);
}

/**
 * All identifiers referenced inside the given line ranges (the whole file when omitted) that
 * resolve through the file's imports or to its own exports. Shadowing by local variables is not
 * modelled: a local named like an import still counts.
 */
export function referencedSymbols(path: string, text: string, ranges?: { start: number; end: number }[]): SymbolId[] {
	const sf = parse(path, text);
	const { named, namespaces } = readImports(path, sf);
	const own = new Map(indexParsed(path, sf).exported.map((info) => [info.name, info.id]));
	const found = new Set<SymbolId>();
	const inRange = (node: ts.Node) => {
		if (ranges === undefined) {
			return true;
		}
		const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
		return ranges.some((range) => line >= range.start && line <= range.end);
	};

	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			return;
		}
		if (ts.isIdentifier(node) && inRange(node)) {
			const parent = node.parent;
			const namespacePath = namespaces.get(node.text);
			if (namespacePath !== undefined) {
				// `ns.name` in an expression, or `ns.Name` in a type.
				if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
					found.add(symbolId(namespacePath, parent.name.text));
				} else if (ts.isQualifiedName(parent) && parent.left === node) {
					found.add(symbolId(namespacePath, parent.right.text));
				}
			} else if (!isNotAReference(node)) {
				const target = named.get(node.text) ?? own.get(node.text);
				if (target !== undefined) {
					found.add(target);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return [...found].sort();
}
