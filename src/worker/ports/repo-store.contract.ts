// The behaviour every RepoStore must have. Framework-free on purpose: vitest runs it against
// MemoryRepoStore, and the deployed Worker runs the same cases against real Artifacts
// (POST /api/admin/smoke).
import { type RepoStore, StaleHeadError, ZERO_SHA } from "./repo-store";

export interface ContractResult {
	name: string;
	ok: boolean;
	error?: string;
	ms: number;
}

export interface ContractCase {
	name: string;
	/** `repo(label)` returns a fresh repo name that the harness removes afterwards. */
	run(store: RepoStore, repo: (label: string) => string): Promise<void>;
}

function equal(actual: unknown, expected: unknown, what: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${what}: expected ${e}, got ${a}`);
	}
}

function ok(condition: boolean, what: string): void {
	if (!condition) {
		throw new Error(what);
	}
}

async function rejects(promise: Promise<unknown>, what: string): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error(`${what}: expected a rejection`);
}

export const contractCases: ContractCase[] = [
	{
		name: "ensureRepo creates an empty repo and is idempotent",
		async run(store, repo) {
			const name = repo("empty");
			await store.ensureRepo(name);
			await store.ensureRepo(name);
			equal(await store.head(name), ZERO_SHA, "head of an empty repo");
			equal(await store.listFiles(name, "main"), [], "files in an empty repo");
			equal(await store.snapshot(name, "main"), {}, "snapshot of an empty repo");
		},
	},
	{
		name: "commit then readFile, by branch and by sha",
		async run(store, repo) {
			const name = repo("commit");
			await store.ensureRepo(name);
			const first = await store.commit(name, ZERO_SHA, { "README.md": "# one\n", "src/a.ts": "export const a = 1;\n" }, "first");
			ok(/^[0-9a-f]{40}$/.test(first), `commit returns a 40-char sha, got ${first}`);
			equal(await store.head(name), first, "head after the first commit");
			equal(await store.readFile(name, "main", "src/a.ts"), "export const a = 1;\n", "read by branch");

			const second = await store.commit(name, first, { "src/a.ts": "export const a = 2;\n" }, "second");
			ok(second !== first, "second commit has a new sha");
			equal(await store.head(name), second, "head after the second commit");
			equal(await store.readFile(name, "main", "src/a.ts"), "export const a = 2;\n", "read by branch after edit");
			equal(await store.readFile(name, first, "src/a.ts"), "export const a = 1;\n", "read the old version by sha");
			equal(await store.readFile(name, second, "README.md"), "# one\n", "untouched file survives");
			equal(await store.readFile(name, "main", "src/missing.ts"), null, "missing file reads as null");
		},
	},
	{
		name: "commit throws StaleHeadError when main has moved",
		async run(store, repo) {
			const name = repo("stale");
			await store.ensureRepo(name);
			const first = await store.commit(name, ZERO_SHA, { "a.txt": "1" }, "first");
			const second = await store.commit(name, first, { "a.txt": "2" }, "second");

			const error = await rejects(store.commit(name, first, { "a.txt": "3" }, "stale"), "commit on an old head");
			ok(error instanceof StaleHeadError, `expected StaleHeadError, got ${String(error)}`);
			equal((error as StaleHeadError).actual, second, "StaleHeadError.actual");
			equal(await store.head(name), second, "head is unchanged after a stale commit");
			equal(await store.readFile(name, "main", "a.txt"), "2", "content is unchanged after a stale commit");

			const fromZero = await rejects(store.commit(name, ZERO_SHA, { "a.txt": "4" }, "stale"), "commit from ZERO_SHA on a non-empty repo");
			ok(fromZero instanceof StaleHeadError, `expected StaleHeadError, got ${String(fromZero)}`);
		},
	},
	{
		name: "null in changes deletes a file",
		async run(store, repo) {
			const name = repo("delete");
			await store.ensureRepo(name);
			const first = await store.commit(name, ZERO_SHA, { "keep.txt": "k", "src/gone.ts": "g", "src/stay.ts": "s" }, "first");
			const second = await store.commit(name, first, { "src/gone.ts": null, "never-existed.txt": null }, "delete");
			equal(await store.readFile(name, "main", "src/gone.ts"), null, "deleted file reads as null");
			equal(await store.listFiles(name, "main"), ["keep.txt", "src/stay.ts"], "files after delete");
			equal(await store.readFile(name, first, "src/gone.ts"), "g", "deleted file is still in the old commit");
			equal(await store.changedPaths(name, first, second), ["src/gone.ts"], "changedPaths for a delete");
		},
	},
	{
		name: "listFiles and snapshot return the whole tree",
		async run(store, repo) {
			const name = repo("tree");
			await store.ensureRepo(name);
			const files = {
				"README.md": "# readme\n",
				"src/auth/session.ts": "export const session = 1;\n",
				"src/auth/login.ts": "export const login = 1;\n",
				"src/billing/deep/tax.ts": "export const tax = 1;\n",
			};
			const sha = await store.commit(name, ZERO_SHA, files, "tree");
			const sorted = ["README.md", "src/auth/login.ts", "src/auth/session.ts", "src/billing/deep/tax.ts"];
			equal(await store.listFiles(name, "main"), sorted, "listFiles by branch");
			equal(await store.listFiles(name, sha), sorted, "listFiles by sha");
			const snapshot = await store.snapshot(name, sha);
			equal(Object.keys(snapshot).sort(), sorted, "snapshot paths");
			for (const [path, content] of Object.entries(files)) {
				equal(snapshot[path], content, `snapshot content of ${path}`);
			}
		},
	},
	{
		name: "changedPaths lists adds, edits and deletes between two commits",
		async run(store, repo) {
			const name = repo("diff");
			await store.ensureRepo(name);
			const first = await store.commit(name, ZERO_SHA, { "a.txt": "a", "src/x/one.ts": "1", "src/x/two.ts": "2", "src/y/same.ts": "s" }, "first");
			const second = await store.commit(name, first, { "a.txt": "A", "src/x/two.ts": null, "src/z/new.ts": "n" }, "second");
			equal(await store.changedPaths(name, first, second), ["a.txt", "src/x/two.ts", "src/z/new.ts"], "first..second");
			equal(await store.changedPaths(name, second, first), ["a.txt", "src/x/two.ts", "src/z/new.ts"], "second..first");
			equal(await store.changedPaths(name, second, second), [], "same commit");
			equal(await store.changedPaths(name, ZERO_SHA, first), ["a.txt", "src/x/one.ts", "src/x/two.ts", "src/y/same.ts"], "from ZERO_SHA");
		},
	},
	{
		name: "a fork starts at the source head and then moves independently",
		async run(store, repo) {
			const source = repo("source");
			const target = repo("fork");
			await store.ensureRepo(source);
			const base = await store.commit(source, ZERO_SHA, { "src/a.ts": "base\n", "src/b.ts": "b\n" }, "base");

			const forked = await store.fork(source, target);
			equal(forked.head, base, "fork head");
			equal(await store.head(target), base, "head() of the fork");
			equal(await store.readFile(target, "main", "src/a.ts"), "base\n", "fork sees the source content");

			const inFork = await store.commit(target, base, { "src/a.ts": "fork\n" }, "edit in fork");
			const inSource = await store.commit(source, base, { "src/b.ts": "source\n" }, "edit in source");
			equal(await store.head(target), inFork, "fork head after its own commit");
			equal(await store.head(source), inSource, "source head after its own commit");
			equal(await store.readFile(source, "main", "src/a.ts"), "base\n", "source did not get the fork's edit");
			equal(await store.readFile(target, "main", "src/b.ts"), "b\n", "fork did not get the source's edit");
			equal(await store.readFile(target, base, "src/a.ts"), "base\n", "fork can read the base commit by sha");
			equal(await store.changedPaths(target, base, inFork), ["src/a.ts"], "changedPaths in the fork");
		},
	},
	{
		name: "list names the repos that exist",
		async run(store, repo) {
			const one = repo("list-a");
			const two = repo("list-b");
			await store.ensureRepo(one);
			await store.ensureRepo(two);
			const names = await store.list();
			ok(names.includes(one) && names.includes(two), `list() should include ${one} and ${two}, got ${names.length} names`);
			equal([...names].sort(), names, "list() is sorted");
			await store.remove(one);
			ok(!(await store.list()).includes(one), "a removed repo is not listed");
		},
	},
	{
		name: "remove deletes a repo",
		async run(store, repo) {
			const name = repo("remove");
			await store.ensureRepo(name);
			await store.commit(name, ZERO_SHA, { "a.txt": "a" }, "first");
			await store.remove(name);
			await rejects(store.head(name), "head() of a removed repo");
		},
	},
];

/**
 * Runs every case against a fresh store from `makeStore` and removes the repos it created.
 * `prefix` namespaces the repo names; the deployed smoke route uses "smoke".
 */
export async function runContract(
	makeStore: () => RepoStore,
	options: { prefix?: string; parallel?: boolean; cases?: ContractCase[] } = {},
): Promise<ContractResult[]> {
	const prefix = options.prefix ?? "contract";
	const run = crypto.randomUUID().slice(0, 8);

	async function runCase(testCase: ContractCase, index: number): Promise<ContractResult> {
		const store = makeStore();
		const created: string[] = [];
		const repo = (label: string) => {
			const name = `${prefix}-${run}-${index}-${label}`;
			created.push(name);
			return name;
		};
		const start = Date.now();
		try {
			await testCase.run(store, repo);
			return { name: testCase.name, ok: true, ms: Date.now() - start };
		} catch (error) {
			return { name: testCase.name, ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - start };
		} finally {
			for (const name of created) {
				await store.remove(name).catch(() => undefined);
			}
		}
	}

	const cases = options.cases ?? contractCases;
	if (options.parallel) {
		return Promise.all(cases.map(runCase));
	}
	const results: ContractResult[] = [];
	for (const [index, testCase] of cases.entries()) {
		results.push(await runCase(testCase, index));
	}
	return results;
}
