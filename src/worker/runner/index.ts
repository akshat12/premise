// The behavioural runner: runs a repo's tests and premise assertions inside an isolated Dynamic
// Worker with no network access, and reports pass or fail per item.
import type { WorkerEntrypoint } from "cloudflare:workers";
import type { Assertion } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";
import { fnv1a64 } from "../surface";
import { indexFile, isIndexedPath, resolveImport } from "../symbols";
import ts from "../ts";

export interface RunRequest {
	files: FileMap;
	tests: { file: string; name: string }[];
	assertions: Assertion[];
	cpuMs?: number;
}

export interface RunResult {
	tests: { file: string; name: string; ok: boolean; error?: string; ms: number }[];
	assertions: { id: string; ok: boolean; error?: string; ms: number }[];
	loadError?: string;
}

export const ASSERT_MODULE = "premise/assert.ts";
export const RUNNER_MODULE = "__runner.js";
/** A single item may run this many loop iterations before it is stopped. */
export const LOOP_BUDGET = 5_000_000;
const ITEM_TIMEOUT_MS = 5_000;
const WALL_CLOCK_MS = 20_000;
const DEFAULT_CPU_MS = 5_000;
const COMPATIBILITY_DATE = "2026-10-01";

/** Module key for a repo file: the same path with a .js extension. Relative imports between such keys resolve (T00). */
export const moduleKey = (path: string) => path.replace(/\.ts$/, ".js");

/**
 * Wraps every loop body in a call to `__premiseTick()`, which throws once an item has gone
 * round more than LOOP_BUDGET times. Local workerd does not enforce CPU limits, so without
 * this an infinite loop in a test would hang the whole process.
 */
const guardLoops: ts.TransformerFactory<ts.SourceFile> = (context) => {
	const factory = context.factory;
	const visit = (node: ts.Node): ts.Node => {
		const visited = ts.visitEachChild(node, visit, context);
		if (!ts.isIterationStatement(visited, false)) {
			return visited;
		}
		const tick = factory.createExpressionStatement(factory.createCallExpression(factory.createIdentifier("__premiseTick"), undefined, []));
		const body = factory.createBlock([tick, visited.statement], true);
		if (ts.isForStatement(visited)) {
			return factory.updateForStatement(visited, visited.initializer, visited.condition, visited.incrementor, body);
		}
		if (ts.isForOfStatement(visited)) {
			return factory.updateForOfStatement(visited, visited.awaitModifier, visited.initializer, visited.expression, body);
		}
		if (ts.isForInStatement(visited)) {
			return factory.updateForInStatement(visited, visited.initializer, visited.expression, body);
		}
		if (ts.isWhileStatement(visited)) {
			return factory.updateWhileStatement(visited, visited.expression, body);
		}
		return factory.updateDoStatement(visited as ts.DoStatement, body, (visited as ts.DoStatement).expression);
	};
	return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
};

interface Transpiled {
	js: string;
	/** A syntax error, if the source does not parse. A module with one would stop the whole Worker from starting. */
	syntaxError?: string;
}

const transpileCache = new Map<string, Transpiled>();

/** TypeScript to JavaScript for one module: types stripped, import specifiers normalised to `.js`, loops guarded. */
export function transpile(path: string, source: string): Transpiled {
	const key = `${path}:${fnv1a64(source)}`;
	const cached = transpileCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const out = ts.transpileModule(source, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false },
		transformers: { before: [guardLoops] },
	});
	const firstError = out.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	const result: Transpiled = { js: normalizeSpecifiers(out.outputText) };
	if (firstError !== undefined) {
		const line = firstError.file && firstError.start !== undefined ? firstError.file.getLineAndCharacterOfPosition(firstError.start).line + 1 : 0;
		result.syntaxError = `${path}:${line}: ${ts.flattenDiagnosticMessageText(firstError.messageText, " ")}`;
	}
	if (transpileCache.size > 2000) {
		transpileCache.clear();
	}
	transpileCache.set(key, result);
	return result;
}

/** `from "./x"` and `from "./x.ts"` become `from "./x.js"`, so every relative specifier is a module key. */
export function normalizeSpecifiers(js: string): string {
	return js.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g, (_match, lead: string, quote: string, specifier: string) => {
		const fixed = specifier.endsWith(".ts") ? `${specifier.slice(0, -3)}.js` : /\.[a-z]+$/.test(specifier) ? specifier : `${specifier}.js`;
		return `${lead}${quote}${fixed}${quote}`;
	});
}

/** The repo files a file imports with a relative specifier, as repo paths. */
function relativeImports(path: string, source: string): string[] {
	return ts
		.preProcessFile(source, true, true)
		.importedFiles.map((imported) => resolveImport(path, imported.fileName))
		.filter((resolved): resolved is string => resolved !== null);
}

/** `start` plus everything it reaches through relative imports, limited to files that exist. */
function closure(files: FileMap, start: readonly string[]): string[] {
	const seen = new Set<string>();
	const queue = [...start];
	while (queue.length > 0) {
		const path = queue.pop() as string;
		const source = files[path];
		if (seen.has(path) || source === undefined) {
			continue;
		}
		seen.add(path);
		queue.push(...relativeImports(path, source));
	}
	return [...seen];
}

/** `"src/auth/session.ts"`, tolerating `./`, a leading slash, a `#symbol` suffix, or a `.js` extension. */
export function normalizeImportPath(path: string): string {
	const bare = (path.split("#")[0] ?? "").replace(/^\.?\/+/, "");
	return bare.endsWith(".ts") ? bare : `${bare.replace(/\.js$/, "")}.ts`;
}

/** The names a module exports at runtime (not interfaces or type aliases, which have no value). */
function valueExports(path: string, source: string): string[] {
	return indexFile(path, source)
		.filter((symbol) => symbol.kind !== "interface" && symbol.kind !== "type" && symbol.name !== "default")
		.map((symbol) => symbol.name);
}

/** The source of the module that runs one assertion. Its code can use `assert` and every export of its imports. */
export function assertionSource(assertion: Assertion, files: FileMap): { source: string; error?: string } {
	const imports = assertion.imports.map(normalizeImportPath);
	const missing = imports.filter((path) => files[path] === undefined);
	if (files[ASSERT_MODULE] === undefined) {
		return { source: "", error: `the repo has no ${ASSERT_MODULE}` };
	}
	if (missing.length > 0) {
		return { source: "", error: `assertion imports a file that does not exist: ${missing.join(", ")}` };
	}
	const reserved = new Set(["assert", "run"]);
	const names = [...new Set(imports.flatMap((path) => valueExports(path, files[path] ?? "")))].filter((name) => !reserved.has(name));
	const lines = [
		`import * as assert from "./${moduleKey(ASSERT_MODULE)}";`,
		...imports.map((path, index) => `import * as m${index} from "./${moduleKey(path)}";`),
		`const { ${names.join(", ")} } = { ${imports.map((_, index) => `...m${index}`).join(", ")} };`,
		"export const run = async () => {",
		assertion.code,
		"};",
	];
	return { source: lines.join("\n") };
}

interface Item {
	kind: "test" | "assertion";
	/** Index into `req.tests` or `req.assertions`. */
	index: number;
	module: string;
	name?: string;
	/** Module keys written by an agent that this item loads: its test file and helpers, or its assertion module. */
	uses: string[];
}

export interface RunPlan {
	modules: Record<string, string>;
	items: Item[];
	/** Items that cannot run, with the reason, keyed `test:<index>` or `assertion:<index>`. */
	failures: Map<string, string>;
	/** Set when the repo's own source does not parse: nothing can run. */
	loadError?: string;
}

/** Decides which modules to load and which items can run. Pure. */
export function planRun(req: RunRequest): RunPlan {
	const { files } = req;
	const modules: Record<string, string> = {};
	const items: Item[] = [];
	const failures = new Map<string, string>();
	const broken = new Map<string, string>();
	let loadError: string | undefined;

	const add = (path: string, source: string, fatal: boolean): boolean => {
		const out = transpile(path, source);
		if (out.syntaxError !== undefined) {
			broken.set(path, out.syntaxError);
			if (fatal) {
				loadError ??= `syntax error in ${out.syntaxError}`;
			}
			return false;
		}
		modules[moduleKey(path)] = out.js;
		return true;
	};

	// The repo's own code. A syntax error here is fatal: everything depends on it.
	for (const path of Object.keys(files).filter(isIndexedPath).sort()) {
		add(path, files[path] ?? "", true);
	}
	if (files[ASSERT_MODULE] !== undefined) {
		add(ASSERT_MODULE, files[ASSERT_MODULE], true);
	}

	// Test files and whatever they import (helpers under tests/, for example).
	const testFiles = [...new Set(req.tests.map((test) => test.file))];
	for (const path of closure(files, testFiles).sort()) {
		if (modules[moduleKey(path)] === undefined && !broken.has(path)) {
			add(path, files[path] ?? "", false);
		}
	}
	req.tests.forEach((test, index) => {
		const reach = files[test.file] === undefined ? [] : closure(files, [test.file]);
		const bad = reach.find((path) => broken.has(path));
		if (files[test.file] === undefined) {
			failures.set(`test:${index}`, `test file not found: ${test.file}`);
		} else if (bad !== undefined) {
			failures.set(`test:${index}`, `syntax error in ${broken.get(bad)}`);
		} else {
			const uses = reach.filter((path) => !isIndexedPath(path) && path !== ASSERT_MODULE).map(moduleKey);
			items.push({ kind: "test", index, module: `./${moduleKey(test.file)}`, name: test.name, uses });
		}
	});

	req.assertions.forEach((assertion, index) => {
		const generated = assertionSource(assertion, files);
		const key = `__assert_${index}.js`;
		// Transpiled under a .ts name so the assertion's code may use TypeScript syntax.
		const out = generated.error === undefined ? transpile(`__assert_${index}.ts`, generated.source) : undefined;
		if (generated.error !== undefined) {
			failures.set(`assertion:${index}`, generated.error);
		} else if (out?.syntaxError !== undefined) {
			failures.set(`assertion:${index}`, `the assertion's code does not parse: ${out.syntaxError.replace(/^__assert_\d+\.ts:\d+: /, "")}`);
		} else if (out !== undefined) {
			modules[key] = out.js;
			items.push({ kind: "assertion", index, module: `./${key}`, uses: [key] });
		}
	});

	modules[RUNNER_MODULE] = runnerSource(items);
	return loadError === undefined ? { modules, items, failures } : { modules, items, failures, loadError };
}

/** The Dynamic Worker's entry module. It imports each item's module on demand, so one bad module fails only its own items. */
function runnerSource(items: readonly Item[]): string {
	return `import { WorkerEntrypoint } from "cloudflare:workers";

const ITEMS = ${JSON.stringify(items.map(({ uses: _uses, ...item }) => item))};
let ticks = 0;
globalThis.__premiseTick = () => {
	if (++ticks > ${LOOP_BUDGET}) {
		throw new Error("stopped: a loop ran more than ${LOOP_BUDGET.toLocaleString("en-US")} times (possible infinite loop)");
	}
};
const describe = (e) => (e instanceof Error ? (e.name && e.name !== "Error" && e.name !== "AssertionError" ? e.name + ": " : "") + e.message : String(e));
const withTimeout = (work) => {
	let timer;
	const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out after ${ITEM_TIMEOUT_MS} ms")), ${ITEM_TIMEOUT_MS}); });
	return Promise.race([work, limit]).finally(() => clearTimeout(timer));
};

export class Runner extends WorkerEntrypoint {
	async run() {
		const results = [];
		for (const item of ITEMS) {
			ticks = 0;
			const start = Date.now();
			try {
				await withTimeout((async () => {
					const loaded = await import(item.module);
					if (item.kind === "assertion") {
						await loaded.run();
						return;
					}
					const test = loaded.tests?.[item.name];
					if (typeof test !== "function") {
						throw new Error(loaded.tests === undefined ? "the test file does not export \`tests\`" : "no test named " + JSON.stringify(item.name));
					}
					await test();
				})());
				results.push({ kind: item.kind, index: item.index, ok: true, ms: Date.now() - start });
			} catch (e) {
				results.push({ kind: item.kind, index: item.index, ok: false, error: describe(e), ms: Date.now() - start });
			}
		}
		return results;
	}
}
`;
}

/** The modules a run would load, keyed by module name. Pure. */
export function buildModules(req: RunRequest): Record<string, string> {
	return planRun(req).modules;
}

const MAX_START_RETRIES = 10;

/** Which module a "Failed to start Worker" error points at, if it names one we loaded. */
export function startFailureModule(message: string, modules: Record<string, string>): string | undefined {
	for (const match of message.matchAll(/\bat (?:file:\/\/\/)?([^\s:()]+):\d+:\d+/g)) {
		const name = match[1] as string;
		if (name !== RUNNER_MODULE && modules[name] !== undefined) {
			return name;
		}
	}
	return undefined;
}

type IsolateResult = { kind: "test" | "assertion"; index: number; ok: boolean; error?: string; ms: number };
type RunnerEntrypoint = WorkerEntrypoint & { run(): Promise<IsolateResult[]> };

function assemble(req: RunRequest, outcome: (kind: "test" | "assertion", index: number) => { ok: boolean; error?: string; ms: number }, loadError?: string): RunResult {
	const tests = req.tests.map((test, index) => ({ file: test.file, name: test.name, ...outcome("test", index) }));
	const assertions = req.assertions.map((assertion, index) => ({ id: assertion.id, ...outcome("assertion", index) }));
	return loadError === undefined ? { tests, assertions } : { tests, assertions, loadError };
}

/**
 * Runs the requested tests and assertions against `files` in a fresh isolate. Never throws for
 * a failing item: a syntax error, a missing module, a thrown error, a loop that will not stop
 * and a call to the network all come back as a failed item with a reason.
 */
export async function runInIsolate(env: Pick<Env, "LOADER">, req: RunRequest): Promise<RunResult> {
	const plan = planRun(req);
	if (plan.loadError !== undefined) {
		const error = plan.loadError;
		return assemble(req, () => ({ ok: false, error, ms: 0 }), error);
	}
	if (plan.items.length === 0) {
		return assemble(req, (kind, index) => ({ ok: false, error: plan.failures.get(`${kind}:${index}`) ?? "nothing to run", ms: 0 }));
	}

	const failures = new Map(plan.failures);
	const modules = { ...plan.modules };
	let items = plan.items;
	let results: IsolateResult[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;

	// The transpiler catches most syntax errors, but not every one JavaScript rejects (a second
	// `const` with the same name, an `import` inside a function). One such module stops the whole
	// Worker from starting. The runtime names the module, so drop it, fail its items, and try again.
	for (let attempt = 0; items.length > 0; attempt++) {
		try {
			// A fresh isolate every run, never a cached one: repo modules may hold state, and a test
			// must not see what an earlier run left behind.
			const worker = env.LOADER.load({
				compatibilityDate: COMPATIBILITY_DATE,
				mainModule: RUNNER_MODULE,
				modules,
				globalOutbound: null,
				limits: { cpuMs: req.cpuMs ?? DEFAULT_CPU_MS },
			});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`the run did not finish within ${WALL_CLOCK_MS / 1000} seconds`)), WALL_CLOCK_MS);
			});
			results = await Promise.race([worker.getEntrypoint<RunnerEntrypoint>("Runner").run(), timeout]);
			break;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const culprit = attempt < MAX_START_RETRIES ? startFailureModule(message, modules) : undefined;
			const affected = culprit === undefined ? [] : items.filter((item) => item.uses.includes(culprit));
			if (culprit === undefined || affected.length === 0) {
				// The repo's own code, or something we cannot place: nothing can run.
				return assemble(req, (kind, index) => ({ ok: false, error: failures.get(`${kind}:${index}`) ?? message, ms: 0 }), message);
			}
			const reason = message.replace(/^Failed to start Worker:\s*/, "").replace(/^Uncaught /, "").replace(/\s+/g, " ").trim();
			for (const item of affected) {
				failures.set(`${item.kind}:${item.index}`, reason);
			}
			delete modules[culprit];
			items = items.filter((item) => !affected.includes(item));
			modules[RUNNER_MODULE] = runnerSource(items);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	const byKey = new Map(results.map((result) => [`${result.kind}:${result.index}`, result]));
	return assemble(req, (kind, index) => {
		const key = `${kind}:${index}`;
		const result = byKey.get(key);
		if (result !== undefined) {
			return result.error === undefined ? { ok: result.ok, ms: result.ms } : { ok: result.ok, error: result.error, ms: result.ms };
		}
		return { ok: false, error: failures.get(key) ?? "the item did not run", ms: 0 };
	});
}
