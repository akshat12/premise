// T00 spikes. Throwaway code: proves Artifacts fork/read/push, TypeScript-in-Worker,
// and the Dynamic Worker test runner. Not the app.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import ts from "typescript";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { createGitFs } from "./git-fs";
import { TS_LIBS } from "./ts-libs.generated";

const AUTHOR = { name: "Premise spike", email: "spike@premise.dev" };
const A_V1 = "export const a = 1;\n";
const A_V2 = "export const a = 2;\n";

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const start = Date.now();
	const value = await fn();
	return [value, Date.now() - start];
}

function authFor(token: string) {
	// Tokens look like art_v1_<40hex>?expires=<unix>. Basic auth wants only the secret.
	const password = token.split("?expires=")[0];
	return () => ({ username: "x", password });
}

// get() throws while a repo is still "forking", so poll briefly.
async function getWhenReady(artifacts: Artifacts, name: string, attempts = 20) {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return { repo: await artifacts.get(name), retries: i };
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw lastError;
}

async function artifactsSpike(env: Env, url: URL) {
	const rand = crypto.randomUUID().slice(0, 8);
	const baseName = `spike-base-${rand}`;
	const forkName = `spike-fork-${rand}`;
	const depthParam = url.searchParams.get("depth");
	const depth = depthParam === "full" ? undefined : Number(depthParam ?? "1");
	const dir = "/workspace";

	try {
		// 1. create the base repo
		const [created, createMs] = await timed(() => env.ARTIFACTS.create(baseName));

		// 2. init, write, commit, push main
		const baseFs = createGitFs();
		await git.init({ fs: baseFs, dir, defaultBranch: "main" });
		await baseFs.promises.writeFile(`${dir}/README.md`, "# spike base\n");
		await baseFs.promises.writeFile(`${dir}/src/a.ts`, A_V1);
		await git.add({ fs: baseFs, dir, filepath: "README.md" });
		await git.add({ fs: baseFs, dir, filepath: "src/a.ts" });
		await git.commit({ fs: baseFs, dir, message: "base: initial files", author: AUTHOR });
		const [, basePushMs] = await timed(() =>
			git.push({ fs: baseFs, http, dir, url: created.remote, ref: "main", onAuth: authFor(created.token) }),
		);

		// 3. get() then fork()
		using base = await env.ARTIFACTS.get(baseName);
		const [forked, forkMs] = await timed(() => base.fork(forkName));
		const [ready, forkReadyMs] = await timed(() => getWhenReady(env.ARTIFACTS, forkName));
		using fork = ready.repo;

		// 4. readFile on the fork
		const [file, readFileMs] = await timed(() => fork.readFile({ ref: "main", path: "src/a.ts" }));
		const fileTextBeforePush = file === null ? null : await file.text();

		// 5. clone the fork (shallow unless ?depth=full), edit, commit, push
		const forkFs = createGitFs();
		const onAuth = authFor(forked.token);
		const [, cloneMs] = await timed(() =>
			git.clone({ fs: forkFs, http, dir, url: forked.remote, ref: "main", singleBranch: true, depth, onAuth }),
		);
		await forkFs.promises.writeFile(`${dir}/src/a.ts`, A_V2);
		await git.add({ fs: forkFs, dir, filepath: "src/a.ts" });
		const headSha = await git.commit({ fs: forkFs, dir, message: "fork: edit src/a.ts", author: AUTHOR });
		const [pushResult, pushMs] = await timed(() =>
			git.push({ fs: forkFs, http, dir, url: forked.remote, ref: "main", onAuth }),
		);

		// 6. log on the fork, and re-read the pushed file
		const [commits, logMs] = await timed(() => fork.log({ limit: 5 }));
		const pushedFile = await fork.readFile({ ref: "main", path: "src/a.ts" });
		const fileText = pushedFile === null ? null : await pushedFile.text();

		return {
			ok: fileText === A_V2 && commits.length === 2,
			depth: depth ?? "full",
			baseName,
			forkName,
			createMs,
			basePushMs,
			forkMs,
			forkReadyMs,
			forkReadyRetries: ready.retries,
			readFileMs,
			cloneMs,
			pushMs,
			logMs,
			pushOk: pushResult.ok,
			headSha,
			commits,
			fileTextBeforePush,
			fileText,
			expectedFileText: A_V2,
		};
	} finally {
		if (url.searchParams.get("keep") !== "1") {
			await env.ARTIFACTS.delete(forkName).catch(() => false);
			await env.ARTIFACTS.delete(baseName).catch(() => false);
		}
	}
}

async function cleanupSpikeRepos(env: Env) {
	const deleted: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await env.ARTIFACTS.list({ limit: 100, cursor });
		for (const repo of page.repos) {
			if (repo.name.startsWith("spike-") && (await env.ARTIFACTS.delete(repo.name))) {
				deleted.push(repo.name);
			}
		}
		cursor = page.cursor ?? undefined;
	} while (cursor);
	return { deleted };
}

const LIB_DIR = "/lib";

function tsSpike() {
	const start = Date.now();
	const sources: Record<string, string> = {
		"/src/session.ts": [
			"export interface Session { userId: string; expiresAt: number }",
			"export function verifySession(token: string): Session | null {",
			'\treturn token.length > 0 ? { userId: token, expiresAt: Date.now() + 1000 } : null;',
			"}",
			"",
		].join("\n"),
		"/src/use.ts": [
			'import { verifySession, type Session } from "./session";',
			"export function currentUser(token: string): string | undefined {",
			"\tconst session: Session | null = verifySession(token);",
			"\treturn session?.userId;",
			"}",
			"",
		].join("\n"),
	};

	const read = (fileName: string): string | undefined =>
		sources[fileName] ?? (fileName.startsWith(`${LIB_DIR}/`) ? TS_LIBS[fileName.slice(LIB_DIR.length + 1)] : undefined);

	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		// The API takes lib *file names*, not the tsconfig short names.
		lib: ["lib.es2022.d.ts"],
		types: [],
		strict: true,
		declaration: true,
		emitDeclarationOnly: true,
	};

	const emitted: Record<string, string> = {};
	const host: ts.CompilerHost = {
		getSourceFile: (fileName, languageVersion) => {
			const text = read(fileName);
			return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
		},
		getDefaultLibFileName: () => `${LIB_DIR}/lib.es2022.d.ts`,
		getDefaultLibLocation: () => LIB_DIR,
		writeFile: (fileName, text) => {
			emitted[fileName] = text;
		},
		getCurrentDirectory: () => "/",
		getCanonicalFileName: (fileName) => fileName,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		fileExists: (fileName) => read(fileName) !== undefined,
		readFile: read,
		directoryExists: (dir) => dir === "/" || dir === "/src" || dir === LIB_DIR,
		getDirectories: () => [],
	};

	const program = ts.createProgram(Object.keys(sources), options, host);
	const emitResult = program.emit();
	const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics].map((d) => ({
		file: d.file?.fileName ?? null,
		code: d.code,
		message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
	}));

	return {
		ok: diagnostics.length === 0 && Object.keys(emitted).length === 2,
		tsVersion: ts.version,
		libFilesLoaded: program.getSourceFiles().filter((f) => f.fileName.startsWith(LIB_DIR)).length,
		emitted,
		diagnostics,
		ms: Date.now() - start,
	};
}

type RunnerEntrypoint = WorkerEntrypoint & {
	run(): Promise<{ name: string; ok: boolean; error?: string }[]>;
};

const RUNNER_JS = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { tests } from "./tests/math.test.js";

export class Runner extends WorkerEntrypoint {
	async run() {
		const results = [];
		for (const [name, fn] of Object.entries(tests)) {
			try {
				await fn();
				results.push({ name, ok: true });
			} catch (error) {
				results.push({ name, ok: false, error: String(error?.message ?? error) });
			}
		}
		return results;
	}
}
`;

async function loaderSpike(env: Env) {
	const transpileStart = Date.now();
	const transpile = (source: string) =>
		ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		}).outputText;

	const modules = {
		"runner.js": RUNNER_JS,
		"src/math.js": transpile("export function add(a: number, b: number): number {\n\treturn a + b;\n}\n"),
		"tests/math.test.js": transpile(
			[
				'import { add } from "../src/math.js";',
				"export const tests: Record<string, () => void> = {",
				'\tadds: () => { if (add(2, 2) !== 4) throw new Error("bad"); },',
				"};",
				"",
			].join("\n"),
		),
	};
	const transpileMs = Date.now() - transpileStart;

	const runStart = Date.now();
	const worker = env.LOADER.load({
		compatibilityDate: "2026-10-01",
		mainModule: "runner.js",
		modules,
		globalOutbound: null,
		limits: { cpuMs: 2000 },
	});
	const results = await worker.getEntrypoint<RunnerEntrypoint>("Runner").run();
	return { results, transpileMs, runMs: Date.now() - runStart };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/artifacts":
					return Response.json(await artifactsSpike(env, url));
				case "/cleanup":
					return Response.json(await cleanupSpikeRepos(env));
				case "/ts":
					return Response.json(tsSpike());
				case "/loader": {
					// Body is exactly the results array; timings travel in a header.
					const { results, ...timings } = await loaderSpike(env);
					return Response.json(results, { headers: { "x-timings": JSON.stringify(timings) } });
				}
				default:
					return Response.json({ routes: ["/artifacts", "/ts", "/loader", "/cleanup"] }, { status: 404 });
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return Response.json({ ok: false, error: err.message, stack: err.stack }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
