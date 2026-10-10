// Typecheck a repo and compute a "type surface" for each exported symbol: the text of its
// declaration as TypeScript emits it into a .d.ts file, so signatures and types only, never
// function bodies or comments. Premises compare these, which is why an internal refactor does
// not turn anyone red.
import ts from "../ts";
import { symbolId } from "../../shared/ids";
import type { SymbolId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import { isIndexedPath, resolveImport } from "../symbols";
import { DEFAULT_LIB, TS_LIBS } from "./libs";

export interface TypecheckResult {
	ok: boolean;
	errors: string[]; // formatted "path:line: message"
	ms: number;
}

export interface SurfaceEntry {
	/** Hash of this symbol's own declaration text. */
	hash: string;
	/** The declaration as emitted, comments removed, whitespace normalised. */
	decl: string;
	/** Other exported symbols this declaration mentions. `diffSurface` follows these. */
	refs: SymbolId[];
}

export type SurfaceMap = Map<SymbolId, SurfaceEntry>;

const LIB_DIR = "/__lib__";

const OPTIONS: ts.CompilerOptions = {
	strict: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	// The compiler API takes lib file names, not the short names used in tsconfig.json.
	lib: [DEFAULT_LIB],
	types: [],
	declaration: true,
	emitDeclarationOnly: true,
	skipLibCheck: true,
	noEmitOnError: false,
};

/** 64-bit FNV-1a as 16 hex characters. Not cryptographic; it only has to tell declarations apart. */
export function fnv1a64(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < text.length; i++) {
		hash ^= BigInt(text.charCodeAt(i));
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

function createProgram(files: FileMap): { program: ts.Program; emitted: Map<string, string> } {
	const emitted = new Map<string, string>();
	const directories = new Set<string>(["/", LIB_DIR]);
	for (const path of Object.keys(files)) {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) {
			directories.add(`/${parts.slice(0, i).join("/")}`);
		}
	}
	const read = (fileName: string): string | undefined =>
		fileName.startsWith(`${LIB_DIR}/`) ? TS_LIBS[fileName.slice(LIB_DIR.length + 1)] : files[fileName.replace(/^\//, "")];

	const host: ts.CompilerHost = {
		getSourceFile: (fileName, languageVersion) => {
			const text = read(fileName);
			return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
		},
		getDefaultLibFileName: () => `${LIB_DIR}/${DEFAULT_LIB}`,
		getDefaultLibLocation: () => LIB_DIR,
		writeFile: (fileName, text) => void emitted.set(fileName.replace(/^\//, ""), text),
		getCurrentDirectory: () => "/",
		getCanonicalFileName: (fileName) => fileName,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (fileName) => read(fileName) !== undefined,
		readFile: read,
		directoryExists: (directory) => directories.has(directory.replace(/\/$/, "") || "/"),
		getDirectories: () => [],
	};

	const roots = Object.keys(files).filter(isIndexedPath).sort().map((path) => `/${path}`);
	return { program: ts.createProgram(roots, OPTIONS, host), emitted };
}

function diagnosticsOf(program: ts.Program): string[] {
	const errors: string[] = [];
	for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		if (diagnostic.file === undefined) {
			errors.push(`(project): ${message}`);
		} else if (!diagnostic.file.fileName.startsWith(`${LIB_DIR}/`)) {
			const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
			errors.push(`${diagnostic.file.fileName.replace(/^\//, "")}:${line}: ${message}`);
		}
	}
	return errors.sort();
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

interface DtsDeclaration {
	name: string;
	exported: boolean;
	text: string;
	node: ts.Node;
}

/** Reads one emitted .d.ts file into surface entries for the source file it came from. */
function surfaceOfDts(sourcePath: string, dtsText: string, printer: ts.Printer): [SymbolId, SurfaceEntry][] {
	const sf = ts.createSourceFile(sourcePath.replace(/\.ts$/, ".d.ts"), dtsText, ts.ScriptTarget.ES2022, true);
	const print = (node: ts.Node) => squash(printer.printNode(ts.EmitHint.Unspecified, node, sf));
	const isExported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
	const isDefault = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false);

	// 1. Every top-level declaration, exported or not. Overloads and merged declarations share a name.
	const declared: DtsDeclaration[] = [];
	const exportedAs = new Map<string, string>(); // exported name -> local name
	const namedImports = new Map<string, SymbolId>();
	const namespaceImports = new Map<string, string>();

	for (const statement of sf.statements) {
		if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
			const target = resolveImport(sourcePath, statement.moduleSpecifier.text);
			const clause = statement.importClause;
			if (target === null || clause === undefined) {
				continue;
			}
			if (clause.name !== undefined) {
				namedImports.set(clause.name.text, symbolId(target, "default"));
			}
			if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					namedImports.set(element.name.text, symbolId(target, (element.propertyName ?? element.name).text));
				}
			} else if (clause.namedBindings !== undefined) {
				namespaceImports.set(clause.namedBindings.name.text, target);
			}
		} else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
			const name = statement.name?.text ?? "default";
			const exported = isExported(statement);
			declared.push({ name, exported, text: print(statement), node: statement });
			if (exported) {
				exportedAs.set(isDefault(statement) ? "default" : name, name);
			}
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name)) {
					const exported = isExported(statement);
					declared.push({ name: declaration.name.text, exported, text: print(statement), node: statement });
					if (exported) {
						exportedAs.set(declaration.name.text, declaration.name.text);
					}
				}
			}
		} else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
			for (const element of statement.exportClause.elements) {
				exportedAs.set(element.name.text, (element.propertyName ?? element.name).text);
			}
		} else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
			exportedAs.set("default", statement.expression.text);
		}
	}

	const byLocalName = new Map<string, DtsDeclaration[]>();
	for (const declaration of declared) {
		byLocalName.set(declaration.name, [...(byLocalName.get(declaration.name) ?? []), declaration]);
	}
	const localToExported = new Map<string, string>();
	for (const [exportedName, localName] of exportedAs) {
		if (!localToExported.has(localName)) {
			localToExported.set(localName, exportedName);
		}
	}

	// 2. For each export: its text, plus the text of any private declarations it leans on, and
	//    the exported symbols it mentions.
	const entries: [SymbolId, SurfaceEntry][] = [];
	for (const [exportedName, localName] of exportedAs) {
		const own = byLocalName.get(localName);
		if (own === undefined) {
			continue;
		}
		const refs = new Set<SymbolId>();
		const privateText: string[] = [];
		const seenPrivate = new Set<string>([localName]);

		const visit = (node: ts.Node): void => {
			if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
				// An inline `import("./x.js").Name` type, which the emitter writes when the source did not import the type.
				const target = resolveImport(sourcePath, node.argument.literal.text);
				const qualifier = node.qualifier;
				if (target !== null && qualifier !== undefined) {
					refs.add(symbolId(target, ts.isIdentifier(qualifier) ? qualifier.text : qualifier.getText(sf).split(".")[0] ?? ""));
				}
			} else if (ts.isIdentifier(node)) {
				const parent = node.parent;
				const namespacePath = namespaceImports.get(node.text);
				if (namespacePath !== undefined) {
					if (ts.isQualifiedName(parent) && parent.left === node) {
						refs.add(symbolId(namespacePath, parent.right.text));
					} else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
						refs.add(symbolId(namespacePath, parent.name.text));
					}
				} else if (!(ts.isQualifiedName(parent) && parent.right === node) && !(ts.isPropertyAccessExpression(parent) && parent.name === node)) {
					const imported = namedImports.get(node.text);
					if (imported !== undefined) {
						refs.add(imported);
					} else if (byLocalName.has(node.text) && !seenPrivate.has(node.text)) {
						const exportedSibling = localToExported.get(node.text);
						if (exportedSibling !== undefined) {
							refs.add(symbolId(sourcePath, exportedSibling));
						} else {
							// A private declaration: it has no id of its own, so its text becomes part of ours.
							seenPrivate.add(node.text);
							for (const helper of byLocalName.get(node.text) ?? []) {
								privateText.push(helper.text);
								visit(helper.node);
							}
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		for (const declaration of own) {
			visit(declaration.node);
		}

		const id = symbolId(sourcePath, exportedName);
		refs.delete(id);
		const decl = [...own.map((declaration) => declaration.text), ...privateText.sort()].join(" ");
		entries.push([id, { hash: fnv1a64(decl), decl, refs: [...refs].sort() }]);
	}
	return entries;
}

function surfaceFromEmit(emitted: Map<string, string>): SurfaceMap {
	const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
	const map: SurfaceMap = new Map();
	for (const dtsPath of [...emitted.keys()].filter((path) => path.endsWith(".d.ts")).sort()) {
		const sourcePath = dtsPath.replace(/\.d\.ts$/, ".ts");
		for (const [id, entry] of surfaceOfDts(sourcePath, emitted.get(dtsPath) ?? "", printer)) {
			map.set(id, entry);
		}
	}
	return map;
}

/** Typecheck and surface from one compiler program. Use this when you need both; it does the work once. */
export function analyze(files: FileMap): { typecheck: TypecheckResult; surface: SurfaceMap; ms: number } {
	const start = Date.now();
	const { program, emitted } = createProgram(files);
	const errors = diagnosticsOf(program);
	const typecheckMs = Date.now() - start;
	program.emit();
	const map = surfaceFromEmit(emitted);
	return { typecheck: { ok: errors.length === 0, errors, ms: typecheckMs }, surface: map, ms: Date.now() - start };
}

/** Typechecks every *.ts file outside tests/ and premise/. */
export function typecheck(files: FileMap): TypecheckResult {
	const start = Date.now();
	const errors = diagnosticsOf(createProgram(files).program);
	return { ok: errors.length === 0, errors, ms: Date.now() - start };
}

/** The type surface of every exported symbol. */
export function surface(files: FileMap): { map: SurfaceMap; ms: number } {
	const start = Date.now();
	const { program, emitted } = createProgram(files);
	program.emit();
	return { map: surfaceFromEmit(emitted), ms: Date.now() - start };
}

/**
 * Which symbols' surfaces differ between two maps. `changed` includes transitive changes: a
 * symbol whose own declaration is identical still counts if it mentions a symbol that changed,
 * was added or was removed (for example a function returning `Session` after `Session` gained a
 * field).
 */
export function diffSurface(before: SurfaceMap, after: SurfaceMap): { changed: SymbolId[]; added: SymbolId[]; removed: SymbolId[] } {
	const added = [...after.keys()].filter((id) => !before.has(id));
	const removed = [...before.keys()].filter((id) => !after.has(id));
	const changed = new Set<SymbolId>([...after.keys()].filter((id) => before.has(id) && before.get(id)?.hash !== after.get(id)?.hash));

	const moved = new Set<SymbolId>([...changed, ...added, ...removed]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const [id, entry] of after) {
			if (moved.has(id)) {
				continue;
			}
			const refs = [...entry.refs, ...(before.get(id)?.refs ?? [])];
			if (refs.some((ref) => moved.has(ref))) {
				moved.add(id);
				changed.add(id);
				grew = true;
			}
		}
	}
	return { changed: [...changed].sort(), added: added.sort(), removed: removed.sort() };
}
