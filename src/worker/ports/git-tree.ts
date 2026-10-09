// Pure helpers for walking and diffing git trees. They take a `readTree` function instead of an
// Artifacts handle, so they can be unit-tested with a fake.

export interface TreeEntry {
	name: string;
	hash: string;
	/** "tree" is a directory. Anything else ("blob", "exec", "symlink", "gitlink") is treated as a leaf. */
	type: string;
}

export type ReadTree = (treeHash: string) => Promise<TreeEntry[] | null>;

export interface TreeFile {
	path: string;
	hash: string;
	type: string;
}

/** Runs `fn` over `items` with at most `limit` calls in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index] as T);
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}

/** Wraps `readTree` so that no more than `limit` reads run at once, however the callers recurse. */
export function limitConcurrency(readTree: ReadTree, limit: number): ReadTree {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (hash) => {
		if (active >= limit) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		active++;
		try {
			return await readTree(hash);
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

function join(prefix: string, name: string): string {
	return prefix === "" ? name : `${prefix}/${name}`;
}

/** Every leaf under `treeHash`, recursively, sorted by path. `null` means an empty tree. */
export async function walkTree(readTree: ReadTree, treeHash: string | null, prefix = ""): Promise<TreeFile[]> {
	if (treeHash === null) {
		return [];
	}
	const entries = (await readTree(treeHash)) ?? [];
	const nested = await Promise.all(
		entries.map(async (entry): Promise<TreeFile[]> => {
			const path = join(prefix, entry.name);
			return entry.type === "tree" ? walkTree(readTree, entry.hash, path) : [{ path, hash: entry.hash, type: entry.type }];
		}),
	);
	return nested.flat().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Paths whose content differs between two trees. Identical subtrees are skipped without being read. */
export async function diffTrees(readTree: ReadTree, from: string | null, to: string | null, prefix = ""): Promise<string[]> {
	if (from === to) {
		return [];
	}
	const [before, after] = await Promise.all([
		from === null ? [] : readTree(from).then((entries) => entries ?? []),
		to === null ? [] : readTree(to).then((entries) => entries ?? []),
	]);
	const beforeByName = new Map(before.map((entry) => [entry.name, entry]));
	const afterByName = new Map(after.map((entry) => [entry.name, entry]));
	const names = new Set([...beforeByName.keys(), ...afterByName.keys()]);

	const nested = await Promise.all(
		[...names].map(async (name): Promise<string[]> => {
			const a = beforeByName.get(name);
			const b = afterByName.get(name);
			const path = join(prefix, name);
			if (a && b && a.hash === b.hash && a.type === b.type) {
				return [];
			}
			const aTree = a?.type === "tree" ? a.hash : null;
			const bTree = b?.type === "tree" ? b.hash : null;
			const changed = await diffTrees(readTree, aTree, bTree, path);
			// A leaf on either side that is not matched by an identical leaf is a changed path.
			const leafChanged = (a !== undefined && a.type !== "tree") || (b !== undefined && b.type !== "tree");
			return leafChanged ? [path, ...changed] : changed;
		}),
	);
	return [...new Set(nested.flat())].sort();
}
