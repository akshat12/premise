// The agent's tools. These are the only way an agent can see or change code, which is what makes
// the record of what it relied on complete.
import { parseSymbolId } from "../../shared/ids";
import type { Assertion, Claim, CommitSha, Intent, IntentId, Premise, SymbolId } from "../../shared/types";
import type { IntentApi } from "../intent/client";
import type { ToolDef } from "../ports/llm";
import { applyChanges } from "../ports/memory-repo-store";
import type { FileChanges, FileMap, RepoStore } from "../ports/repo-store";
import { assertionSource, normalizeImportPath, runInIsolate } from "../runner";
import { analyze, type SurfaceMap } from "../surface";
import { indexFile, indexRepo, isIndexedPath, type SymbolInfo } from "../symbols";

export type AgentEnv = Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER">;
export type Phase = "plan" | "work";

/** The fork as it was when the Intent started: files, symbols and their type surfaces. Computed once per run. */
export interface BaseView {
	repo: string;
	commit: CommitSha;
	files: FileMap;
	index: Map<SymbolId, SymbolInfo>;
	surface: SurfaceMap;
}

export interface ToolContext {
	env: AgentEnv;
	intentId: IntentId;
	intent: IntentApi;
	store: RepoStore;
	phase: Phase;
	base(): Promise<BaseView>;
	/** Files whose symbols were already recorded as premises in this run, so repeat reads stay quiet. */
	recorded: Set<string>;
}

export interface ToolOutcome {
	text: string;
	isError?: boolean;
	/** "claim": the agent declared its changes. "submit": the agent is finished. The driver takes over. */
	signal?: "claim" | "submit";
}

export class ToolError extends Error {}

const MAX_RESULT_CHARS = 60_000;
const MAX_FILE_CHARS = 200_000;
const MAX_SEARCH_RESULTS = 30;
export const READABLE_PREMISE_FILE = "premise/assert.ts";

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

/** The same list on every turn of every run. Phase rules are enforced by the handlers, not by hiding tools. */
export const TOOLS: ToolDef[] = [
	{ name: "list_files", description: "List file paths in the repository, optionally under one directory.", input_schema: object({ dir: str('Directory prefix, e.g. "src/auth". Omit for everything.') }, []) },
	{ name: "read_file", description: "Read a whole file. Every exported symbol in it is recorded as something your work relies on.", input_schema: object({ path: str("Repo-relative path.") }, ["path"]) },
	{ name: "search_symbols", description: "Find exported symbols by name or path (case-insensitive substring). Returns up to 30 with their signatures. Each one returned is recorded as relied on.", input_schema: object({ query: str("Part of a symbol name or path.") }, ["query"]) },
	{ name: "read_symbol", description: 'Read the source of one exported symbol, e.g. "src/auth/session.ts#verifySession". It is recorded as relied on.', input_schema: object({ symbol: str("<path>#<exportName>") }, ["symbol"]) },
	{
		name: "assert_premise",
		description:
			'Record a behaviour your plan depends on as an executable check. Either adopt a pre-written assertion with { "adopt": "<id>" }, or give description, code and imports. The code is the body of an async function; it can use `assert` (ok, eq, deepEq, throws) and every export of the files in imports. It must pass now.',
		input_schema: object(
			{
				adopt: str("Id of a pre-written assertion to adopt."),
				description: str("One line saying what must stay true."),
				code: str("Statements that throw if the behaviour does not hold. No import statements."),
				imports: { type: "array", items: { type: "string" }, description: 'Repo files whose exports the code uses, e.g. ["src/auth/session.ts"].' },
				symbol: str("Optional. The symbol this is about, as <path>#<exportName>."),
			},
			[],
		),
	},
	{
		name: "declare_changes",
		description: "Plan phase only. Declare the exported symbols you will change. Ends the plan phase; the ledger answers Granted, Wait, Split or Depend.",
		input_schema: object(
			{
				claims: {
					type: "array",
					items: object({ symbol: str("<path>#<exportName>"), mode: { type: "string", enum: ["body", "interface"] } }, ["symbol", "mode"]),
				},
				why: { type: "array", items: { type: "string" }, description: "At most three short lines on why you are doing it this way." },
				rejected: { type: "array", items: { type: "string" }, description: "Optional. Alternatives you considered and set aside." },
			},
			["claims", "why"],
		),
	},
	{ name: "write_file", description: "Work phase only. Write the complete new content of a file (source or test).", input_schema: object({ path: str("Repo-relative path."), content: str("The whole file.") }, ["path", "content"]) },
	{ name: "run_checks", description: "Work phase only. Typecheck your changes and run your acceptance tests and assertions.", input_schema: object({}, []) },
	{ name: "submit", description: "Work phase only. Finish: your changes are checked once more and pushed to your fork.", input_schema: object({ message: str("One-line summary of the change.") }, ["message"]) },
];

/** Paths the agent may not see or write: Premise's own files, apart from the assertion helper tests import. */
export function isHidden(path: string): boolean {
	if (path === READABLE_PREMISE_FILE) {
		return false;
	}
	return path.startsWith("premise/") || path.startsWith(".intent/") || path.startsWith("tests/hidden") || path.startsWith(".git");
}

function cleanPath(input: unknown, what = "path"): string {
	if (typeof input !== "string" || input.trim() === "") {
		throw new ToolError(`${what} must be a non-empty string`);
	}
	const path = input.trim().replace(/^\.?\/+/, "");
	if (path.split("/").some((part) => part === ".." || part === "")) {
		throw new ToolError(`${what} must be a plain repo-relative path, got "${input}"`);
	}
	return path;
}

function clip(text: string): string {
	return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n[... ${text.length - MAX_RESULT_CHARS} more characters not shown]`;
}

/** The repo as the agent currently sees it: the base files with its own edits on top. */
export async function effectiveFiles(ctx: ToolContext): Promise<FileMap> {
	const [base, overlay] = await Promise.all([ctx.base(), ctx.intent.overlay()]);
	return applyChanges(base.files, overlay);
}

function observedPremise(base: BaseView, symbol: SymbolId): Premise | null {
	const entry = base.surface.get(symbol);
	return entry === undefined ? null : { symbol, source: "observed", surfaceHash: entry.hash, state: "holding" };
}

async function recordObserved(ctx: ToolContext, symbols: readonly SymbolId[]): Promise<void> {
	const base = await ctx.base();
	const fresh = symbols.filter((symbol) => !ctx.recorded.has(symbol));
	const premises = fresh.map((symbol) => observedPremise(base, symbol)).filter((premise): premise is Premise => premise !== null);
	fresh.forEach((symbol) => ctx.recorded.add(symbol));
	await ctx.intent.recordPremises(premises);
}

function requirePhase(ctx: ToolContext, phase: Phase, tool: string): void {
	if (ctx.phase !== phase) {
		throw new ToolError(
			phase === "work"
				? `${tool} is not allowed in the plan phase. Finish planning and call declare_changes first.`
				: `${tool} is only allowed in the plan phase. Your changes are already declared; continue with write_file, run_checks and submit.`,
		);
	}
}

async function listFiles(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	const dir = input.dir === undefined || input.dir === "" ? "" : `${cleanPath(input.dir, "dir").replace(/\/$/, "")}/`;
	const paths = Object.keys(await effectiveFiles(ctx))
		.filter((path) => !isHidden(path) && path.startsWith(dir))
		.sort();
	return { text: paths.length > 0 ? clip(paths.join("\n")) : `No files under "${dir}".` };
}

async function readFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	const path = cleanPath(input.path);
	const files = await effectiveFiles(ctx);
	const content = isHidden(path) ? undefined : files[path];
	if (content === undefined) {
		throw new ToolError(`No such file: ${path}. Use list_files to see what exists.`);
	}
	const base = await ctx.base();
	// Premises are about the code as it was when the Intent started, so only symbols that exist there count.
	if (isIndexedPath(path) && base.files[path] !== undefined) {
		await recordObserved(ctx, indexFile(path, base.files[path]).map((symbol) => symbol.id));
	}
	return { text: clip(content) };
}

async function searchSymbols(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	if (typeof input.query !== "string" || input.query.trim() === "") {
		throw new ToolError("query must be a non-empty string");
	}
	const needle = input.query.trim().toLowerCase();
	const base = await ctx.base();
	const matches = [...base.index.values()].filter((symbol) => symbol.id.toLowerCase().includes(needle)).slice(0, MAX_SEARCH_RESULTS);
	if (matches.length === 0) {
		return { text: `No exported symbol matches "${input.query}".` };
	}
	await recordObserved(ctx, matches.map((symbol) => symbol.id));
	return { text: matches.map((symbol) => `${symbol.id}\n    ${(base.surface.get(symbol.id)?.decl ?? symbol.kind).slice(0, 240)}`).join("\n") };
}

async function readSymbol(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	if (typeof input.symbol !== "string") {
		throw new ToolError("symbol must be a string like src/auth/session.ts#verifySession");
	}
	let parsed: { path: string; name: string };
	try {
		parsed = parseSymbolId(input.symbol.trim());
	} catch {
		throw new ToolError(`"${input.symbol}" is not a symbol id. Use <path>#<exportName>.`);
	}
	const files = await effectiveFiles(ctx);
	const content = isHidden(parsed.path) ? undefined : files[parsed.path];
	const info = content === undefined ? undefined : indexFile(parsed.path, content).find((symbol) => symbol.name === parsed.name);
	if (content === undefined || info === undefined) {
		throw new ToolError(`No exported symbol ${input.symbol}. Use search_symbols to find it.`);
	}
	await recordObserved(ctx, [info.id]);
	return { text: clip(content.split("\n").slice(info.startLine - 1, info.endLine).join("\n")) };
}

/** The symbol an assertion is about: the first function from its imports that its code calls. */
export function assertionSymbol(assertion: Pick<Assertion, "code" | "imports">, files: FileMap): SymbolId | null {
	const candidates = assertion.imports.map(normalizeImportPath).flatMap((path) => (files[path] === undefined ? [] : indexFile(path, files[path])));
	const called = (name: string) => new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\s*\\(`).test(assertion.code);
	const mentioned = (name: string) => new RegExp(`(^|[^A-Za-z0-9_$])${name}([^A-Za-z0-9_$]|$)`).test(assertion.code);
	return (candidates.find((symbol) => symbol.kind === "function" && called(symbol.name)) ?? candidates.find((symbol) => mentioned(symbol.name)) ?? candidates[0])?.id ?? null;
}

async function assertPremise(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	const files = await effectiveFiles(ctx);
	const intent = await ctx.intent.get();
	let assertion: Assertion;

	if (typeof input.adopt === "string" && input.adopt.trim() !== "") {
		const library = JSON.parse(files["premise/assertions.json"] ?? "[]") as Assertion[];
		const found = library.find((candidate) => candidate.id === input.adopt);
		if (found === undefined) {
			throw new ToolError(`No pre-written assertion "${input.adopt}". Available: ${library.map((candidate) => candidate.id).join(", ") || "none"}.`);
		}
		assertion = found;
	} else {
		if (typeof input.description !== "string" || typeof input.code !== "string" || !Array.isArray(input.imports) || input.imports.some((path) => typeof path !== "string")) {
			throw new ToolError('Give either { "adopt": "<id>" } or all of description (string), code (string) and imports (array of file paths).');
		}
		const taken = new Set(intent.premises.flatMap((premise) => (premise.assertion ? [premise.assertion.id] : [])));
		let n = taken.size + 1;
		while (taken.has(`a${n}`)) {
			n++;
		}
		assertion = { id: `a${n}`, description: input.description.trim(), code: input.code, imports: (input.imports as string[]).map(normalizeImportPath) };
	}

	const generated = assertionSource(assertion, files);
	if (generated.error !== undefined) {
		throw new ToolError(generated.error);
	}
	// A premise has to be true when it is recorded, or it could never break.
	const [result] = (await runInIsolate(ctx.env, { files, tests: [], assertions: [assertion] })).assertions;
	if (result === undefined || !result.ok) {
		throw new ToolError(`This assertion does not hold on the current code, so it cannot be a premise: ${result?.error ?? "it did not run"}`);
	}

	const symbol = typeof input.symbol === "string" && input.symbol.includes("#") ? input.symbol.trim() : assertionSymbol(assertion, files);
	if (symbol === null) {
		throw new ToolError("Could not tell which symbol this assertion is about. Add imports, or pass symbol as <path>#<exportName>.");
	}
	await ctx.intent.recordPremise({ symbol, source: "asserted", surfaceHash: null, assertion, state: "holding" });
	return { text: `Recorded premise ${assertion.id} on ${symbol}: ${assertion.description}` };
}

/** Checks the shape of a declare_changes call. Returns the cleaned values or throws ToolError. */
export function parseDeclaration(input: Record<string, unknown>): { claims: Claim[]; why: string[]; rejected: string[] } {
	if (!Array.isArray(input.claims) || input.claims.length === 0) {
		throw new ToolError("claims must be a non-empty array of { symbol, mode }.");
	}
	const claims = input.claims.map((raw): Claim => {
		const claim = raw as { symbol?: unknown; mode?: unknown };
		if (typeof claim?.symbol !== "string" || (claim.mode !== "body" && claim.mode !== "interface")) {
			throw new ToolError('Each claim needs a symbol ("<path>#<exportName>") and a mode ("body" or "interface").');
		}
		try {
			parseSymbolId(claim.symbol.trim());
		} catch {
			throw new ToolError(`"${claim.symbol}" is not a symbol id. Use <path>#<exportName>, e.g. src/auth/login.ts#handleLogin.`);
		}
		return { symbol: claim.symbol.trim(), mode: claim.mode };
	});
	const offLimits = (path: string) => isHidden(path) || path.startsWith("premise/") || path.startsWith("tests/");
	const hidden = claims.find((claim) => offLimits(parseSymbolId(claim.symbol).path));
	if (hidden !== undefined) {
		throw new ToolError(`${hidden.symbol} cannot be claimed. Declare source symbols only; test files are not declared.`);
	}
	const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []);
	// One claim per symbol. If a symbol is listed twice, the stronger mode wins.
	const bySymbol = new Map<SymbolId, Claim>();
	for (const claim of claims) {
		if (bySymbol.get(claim.symbol)?.mode !== "interface") {
			bySymbol.set(claim.symbol, claim);
		}
	}
	return { claims: [...bySymbol.values()], why: strings(input.why), rejected: strings(input.rejected) };
}

async function declareChanges(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	requirePhase(ctx, "plan", "declare_changes");
	const { claims, why, rejected } = parseDeclaration(input);
	await ctx.intent.setClaims(claims);
	await ctx.intent.setWhy(why);
	for (const alternative of rejected) {
		await ctx.intent.addRejected(alternative);
	}
	// The ledger's answer becomes this call's result; the driver fills it in.
	return { text: "", signal: "claim" };
}

async function writeFile(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	requirePhase(ctx, "work", "write_file");
	const path = cleanPath(input.path);
	if (isHidden(path)) {
		throw new ToolError(`${path} cannot be written.`);
	}
	if (typeof input.content !== "string") {
		throw new ToolError("content must be a string holding the whole file.");
	}
	if (input.content.length > MAX_FILE_CHARS) {
		throw new ToolError(`content is too large (${input.content.length} characters; the limit is ${MAX_FILE_CHARS}).`);
	}
	await ctx.intent.writeOverlay(path, input.content);
	return { text: `Wrote ${path} (${input.content.split("\n").length} lines).` };
}

export interface CheckReport {
	ok: boolean;
	text: string;
}

/** Typechecks the agent's version of the repo and runs its acceptance tests and assertions. */
export async function runChecks(ctx: ToolContext, intent: Intent): Promise<CheckReport> {
	const files = await effectiveFiles(ctx);
	const { typecheck } = analyze(files);
	if (!typecheck.ok) {
		const shown = typecheck.errors.slice(0, 12);
		return { ok: false, text: [`Typecheck: FAILED (${typecheck.errors.length} error${typecheck.errors.length === 1 ? "" : "s"})`, ...shown.map((error) => `  ${error}`), "Tests were not run. Fix the type errors first."].join("\n") };
	}
	const assertions = intent.premises.flatMap((premise) => (premise.assertion && premise.state === "holding" ? [premise.assertion] : []));
	const run = await runInIsolate(ctx.env, { files, tests: intent.acceptance.map((check) => ({ file: check.testFile, name: check.testName })), assertions });
	const lines = ["Typecheck: passed"];
	run.tests.forEach((test, index) => {
		lines.push(`${test.ok ? "PASS" : "FAIL"}  ${intent.acceptance[index]?.id ?? "test"}  ${test.file} > ${JSON.stringify(test.name)}${test.ok ? "" : `\n      ${test.error ?? "failed"}`}`);
	});
	for (const assertion of run.assertions) {
		lines.push(`${assertion.ok ? "HOLDS " : "BROKEN"}  premise ${assertion.id}${assertion.ok ? "" : `\n      ${assertion.error ?? "failed"}`}`);
	}
	const ok = run.loadError === undefined && run.tests.every((test) => test.ok) && run.assertions.every((assertion) => assertion.ok);
	lines.push(ok ? "All checks passed. You can submit." : "Not all checks pass yet.");
	return { ok, text: lines.join("\n") };
}

async function runChecksTool(ctx: ToolContext): Promise<ToolOutcome> {
	requirePhase(ctx, "work", "run_checks");
	const report = await runChecks(ctx, await ctx.intent.get());
	return { text: report.text, isError: !report.ok };
}

async function submit(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
	requirePhase(ctx, "work", "submit");
	if (typeof input.message !== "string" || input.message.trim() === "") {
		throw new ToolError("message must be a one-line summary of the change.");
	}
	const overlay = await ctx.intent.overlay();
	if (Object.keys(overlay).length === 0) {
		throw new ToolError("There is nothing to submit: you have not written any files.");
	}
	// Checked here as well as in run_checks, so nothing that fails its own checks is ever pushed.
	const report = await runChecks(ctx, await ctx.intent.get());
	if (!report.ok) {
		throw new ToolError(`Not submitted, because the checks do not pass:\n${report.text}`);
	}
	return { text: "Submitted.", signal: "submit" };
}

type Handler = (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>;

export const HANDLERS: Record<string, Handler> = {
	list_files: listFiles,
	read_file: readFile,
	search_symbols: searchSymbols,
	read_symbol: readSymbol,
	assert_premise: assertPremise,
	declare_changes: declareChanges,
	write_file: writeFile,
	run_checks: (ctx) => runChecksTool(ctx),
	submit,
};

/** Runs one tool call. Never throws: a bad input or a failed tool comes back as an error result. */
export async function callTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
	const handler = HANDLERS[name];
	if (handler === undefined) {
		return { text: `There is no tool called "${name}". The tools are: ${TOOLS.map((tool) => tool.name).join(", ")}.`, isError: true };
	}
	try {
		return await handler(ctx, input);
	} catch (error) {
		if (error instanceof ToolError) {
			return { text: error.message, isError: true };
		}
		return { text: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
	}
}

/** Builds the per-run context. The base snapshot is loaded and analysed on first use, then kept. */
export function createToolContext(env: AgentEnv, store: RepoStore, intent: IntentApi, intentId: IntentId): ToolContext {
	let base: Promise<BaseView> | undefined;
	return {
		env,
		intentId,
		intent,
		store,
		phase: "plan",
		recorded: new Set(),
		base() {
			base ??= (async () => {
				const record = await intent.get();
				const files = await store.snapshot(record.repo, record.baseCommit);
				return { repo: record.repo, commit: record.baseCommit, files, index: indexRepo(files), surface: analyze(files).surface };
			})();
			return base;
		},
	};
}

/** The agent's edits plus the Intent record, ready to commit to its fork. */
export function commitChanges(intent: Intent, overlay: FileChanges): FileChanges {
	return { ...overlay, ".intent/intent.json": `${JSON.stringify(intent, null, "\t")}\n` };
}
