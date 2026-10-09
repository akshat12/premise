import { describe, expect, it } from "vitest";
import { diffTrees, limitConcurrency, mapLimit, type ReadTree, type TreeEntry, walkTree } from "./git-tree";

// A fake object store: tree hash -> entries.
function fakeTrees(trees: Record<string, TreeEntry[]>): { readTree: ReadTree; reads: string[] } {
	const reads: string[] = [];
	return {
		reads,
		readTree: async (hash) => {
			reads.push(hash);
			return trees[hash] ?? null;
		},
	};
}

const blob = (name: string, hash: string): TreeEntry => ({ name, hash, type: "blob" });
const tree = (name: string, hash: string): TreeEntry => ({ name, hash, type: "tree" });

const TREES: Record<string, TreeEntry[]> = {
	root1: [blob("README.md", "r1"), tree("src", "src1")],
	src1: [tree("auth", "auth1"), tree("billing", "bill1")],
	auth1: [blob("session.ts", "s1"), blob("login.ts", "l1")],
	bill1: [blob("tax.ts", "t1")],
	// root2: session.ts edited, login.ts deleted, util/ added, billing untouched
	root2: [blob("README.md", "r1"), tree("src", "src2")],
	src2: [tree("auth", "auth2"), tree("billing", "bill1"), tree("util", "util2")],
	auth2: [blob("session.ts", "s2")],
	util2: [blob("ids.ts", "i2")],
	// root3: "src" becomes a file
	root3: [blob("README.md", "r1"), blob("src", "srcfile")],
};

describe("walkTree", () => {
	it("lists every leaf recursively, sorted", async () => {
		const { readTree } = fakeTrees(TREES);
		expect((await walkTree(readTree, "root1")).map((f) => f.path)).toEqual([
			"README.md",
			"src/auth/login.ts",
			"src/auth/session.ts",
			"src/billing/tax.ts",
		]);
	});

	it("returns nothing for an empty tree", async () => {
		const { readTree } = fakeTrees(TREES);
		expect(await walkTree(readTree, null)).toEqual([]);
		expect(await walkTree(readTree, "missing")).toEqual([]);
	});
});

describe("diffTrees", () => {
	it("finds edits, deletes and adds", async () => {
		const { readTree } = fakeTrees(TREES);
		expect(await diffTrees(readTree, "root1", "root2")).toEqual(["src/auth/login.ts", "src/auth/session.ts", "src/util/ids.ts"]);
	});

	it("does not read identical subtrees", async () => {
		const { readTree, reads } = fakeTrees(TREES);
		await diffTrees(readTree, "root1", "root2");
		expect(reads).not.toContain("bill1");
	});

	it("returns nothing for the same tree, without reading it", async () => {
		const { readTree, reads } = fakeTrees(TREES);
		expect(await diffTrees(readTree, "root1", "root1")).toEqual([]);
		expect(reads).toEqual([]);
	});

	it("treats a null side as empty", async () => {
		const { readTree } = fakeTrees(TREES);
		const all = ["README.md", "src/auth/login.ts", "src/auth/session.ts", "src/billing/tax.ts"];
		expect(await diffTrees(readTree, null, "root1")).toEqual(all);
		expect(await diffTrees(readTree, "root1", null)).toEqual(all);
	});

	it("handles a directory replaced by a file", async () => {
		const { readTree } = fakeTrees(TREES);
		expect(await diffTrees(readTree, "root1", "root3")).toEqual([
			"src",
			"src/auth/login.ts",
			"src/auth/session.ts",
			"src/billing/tax.ts",
		]);
	});
});

describe("mapLimit and limitConcurrency", () => {
	it("mapLimit keeps order and never exceeds the limit", async () => {
		let active = 0;
		let peak = 0;
		const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setTimeout(resolve, n));
			active--;
			return n * 10;
		});
		expect(out).toEqual([50, 10, 40, 20, 30, 0]);
		expect(peak).toBe(2);
	});

	it("mapLimit handles an empty list", async () => {
		expect(await mapLimit([], 4, async (n: number) => n)).toEqual([]);
	});

	it("limitConcurrency caps recursive tree reads", async () => {
		let active = 0;
		let peak = 0;
		const slow: ReadTree = async (hash) => {
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return TREES[hash] ?? null;
		};
		const files = await walkTree(limitConcurrency(slow, 2), "root1");
		expect(files).toHaveLength(4);
		expect(peak).toBeLessThanOrEqual(2);
	});
});
