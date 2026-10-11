// Generates src/worker/agent/__scripts__/*.json: one recorded agent run per demo task, built from
// the reference solutions in demo-repo/premise/reference/. With LLM="scripted" the agents replay
// these, so the whole pipeline runs with no model key. Run with `npm run agent:scripts`
// (after `npm run demo:reference` if the solutions changed).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SOLUTIONS } from "../demo-solutions/solutions";
import type { Claim, TaskDef } from "../src/shared/types";
import type { AssistantBlock, LlmTurn } from "../src/worker/ports/llm";
import { touchedSymbols } from "../src/worker/symbols";

type FileChanges = Record<string, string | null>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "demo-repo");
const outDir = join(root, "src/worker/agent/__scripts__");
const SESSION = "src/auth/session.ts";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return name === "node_modules" ? [] : statSync(path).isDirectory() ? walk(path) : [path];
	});
}
const trunk: Record<string, string> = Object.fromEntries(walk(repo).map((path) => [relative(repo, path), readFileSync(path, "utf8")]));
const tasks = JSON.parse(trunk["premise/tasks.json"] ?? "[]") as TaskDef[];

async function patch(id: string): Promise<FileChanges> {
	return ((await import(pathToFileURL(join(repo, `premise/reference/${id}.patch.ts`)).href)) as { default: FileChanges }).default;
}

/** Tasks whose plan depends on verifySession throwing: they read session.ts and assert it, in their own words. */
const RELIES_ON_THROW = new Set(["t02-audit-expired", "t03-expired-metrics", "t11-expired-rate-limit"]);
/** Tasks that read session.ts for its types only. */
const READS_SESSION = new Set(["t04-session-ttl-header"]);
/**
 * Symbols a task claims beyond what its solution ends up changing. The discount task also claims
 * computeTotal, its main caller, which is what brings it into contact with the tax task.
 */
const ALSO_CLAIMS: Record<string, Claim[]> = {
	"t06-discount-stacking": [{ symbol: "src/billing/invoice.ts#computeTotal", mode: "body" }],
};
/**
 * What an agent that relies on the throw asserts. It writes the check itself; nothing in the task
 * or the repo hands it one. (The repo's premise/assertions.json library holds the same check for
 * agents that prefer to adopt it; these scripts do not use it.)
 */
const OLD_PREMISE = {
	description: "verifySession throws SessionExpiredError for an expired session",
	imports: [SESSION, "src/store/memory-store.ts"],
	code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.throws(() => verifySession('s1', store, () => 10), SessionExpiredError);",
};
/** What a re-derived agent asserts once it has seen the new behaviour. */
const NEW_PREMISE = {
	description: "verifySession returns null for an expired session",
	imports: [SESSION, "src/store/memory-store.ts"],
	code: "const store = createMemorySessionStore([{ id: 's1', userId: 'u1', expiresAt: 0 }]); assert.eq(verifySession('s1', store, () => 10), null);",
};

let nextId = 0;
const call = (name: string, input: Record<string, unknown>): AssistantBlock => ({ type: "tool_use", id: `toolu_${String(++nextId).padStart(4, "0")}`, name, input });
const turn = (text: string, calls: AssistantBlock[], stop: LlmTurn["stop"] = "tool_use"): LlmTurn => ({ blocks: [{ type: "text", text }, ...calls], stop, usage: { input: 0, output: 0 } });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const solution of SOLUTIONS) {
	const task = tasks.find((candidate) => candidate.id === solution.task);
	if (task === undefined) {
		throw new Error(`no task ${solution.task}`);
	}
	const rederive = solution.appliesOn === "t01";
	// A re-derived run starts from trunk as it is after t01 landed.
	const base = rederive ? { ...trunk, ...(await patch("t01")) } : trunk;
	const changes = await patch(solution.id);
	const sources = Object.keys(changes).filter((path) => path.startsWith("src/")).sort();
	const tests = Object.keys(changes).filter((path) => path.startsWith("tests/")).sort();

	const claims: Claim[] = [
		...sources.flatMap((path) => touchedSymbols(path, (base[path] as string | undefined) ?? null, changes[path] ?? null).map((touch): Claim => ({ symbol: touch.symbol, mode: touch.part }))),
		...(ALSO_CLAIMS[task.id] ?? []),
	];
	if (claims.length === 0) {
		throw new Error(`${solution.id}: the solution touches no exported symbol`);
	}

	nextId = 0;
	const reads = [...new Set([...sources, ...(RELIES_ON_THROW.has(task.id) || READS_SESSION.has(task.id) ? [SESSION] : [])])];
	const turns: LlmTurn[] = [turn("Reading the code this touches.", reads.map((path) => call("read_file", { path })))];
	if (RELIES_ON_THROW.has(task.id)) {
		turns.push(
			rederive
				? turn("verifySession now returns null on expiry; recording that.", [call("assert_premise", NEW_PREMISE)])
				: turn("My plan relies on verifySession throwing on expiry.", [call("assert_premise", OLD_PREMISE)]),
		);
	}
	turns.push(turn("Declaring what I will change.", [call("declare_changes", { claims, why: [solution.summary] })]));
	turns.push(turn("Writing the change and its acceptance tests.", [...sources, ...tests].map((path) => call("write_file", { path, content: changes[path] }))));
	turns.push(turn("Checking.", [call("run_checks", {})]));
	turns.push(turn("Done.", [call("submit", { message: task.title })]));

	const name = rederive ? `${task.id}.rederive` : task.id;
	writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(turns, null, "\t")}\n`);
}

console.log(`wrote ${readdirSync(outDir).length} agent scripts`);
