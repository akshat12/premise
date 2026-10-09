import { describe, expect, it } from "vitest";
import { getMemoryStore, MemoryRepoStore, resetMemoryStore } from "./memory-repo-store";
import { contractCases, runContract } from "./repo-store.contract";
import { StaleHeadError, ZERO_SHA } from "./repo-store";

describe("RepoStore contract: MemoryRepoStore", () => {
	for (const testCase of contractCases) {
		it(testCase.name, async () => {
			const [result] = await runContract(() => new MemoryRepoStore(), { cases: [testCase] });
			expect(result?.error).toBeUndefined();
			expect(result?.ok).toBe(true);
		});
	}

	it("reports a failing case instead of throwing", async () => {
		const results = await runContract(() => new MemoryRepoStore(), {
			cases: [{ name: "always fails", run: async () => { throw new Error("boom"); } }],
		});
		expect(results).toEqual([{ name: "always fails", ok: false, error: "boom", ms: expect.any(Number) }]);
	});
});

describe("MemoryRepoStore", () => {
	it("seeds named repos with one commit", async () => {
		const store = new MemoryRepoStore({ trunk: { "src/a.ts": "export const a = 1;\n", "README.md": "# r\n" } });
		const head = await store.head("trunk");
		expect(head).toMatch(/^[0-9a-f]{40}$/);
		expect(head).not.toBe(ZERO_SHA);
		expect(await store.listFiles("trunk", "main")).toEqual(["README.md", "src/a.ts"]);
		expect(await store.readFile("trunk", head, "src/a.ts")).toBe("export const a = 1;\n");
		expect(await store.changedPaths("trunk", ZERO_SHA, head)).toEqual(["README.md", "src/a.ts"]);
	});

	it("gives identical seeds identical head shas", async () => {
		const files = { "b.txt": "b", "a.txt": "a" };
		const one = new MemoryRepoStore({ trunk: files });
		const two = new MemoryRepoStore({ trunk: { "a.txt": "a", "b.txt": "b" } });
		expect(await one.head("trunk")).toBe(await two.head("trunk"));
	});

	it("keeps forks independent", async () => {
		const store = new MemoryRepoStore({ trunk: { "a.txt": "base" } });
		const base = await store.head("trunk");
		await store.fork("trunk", "i1");
		await store.fork("trunk", "i2");
		await store.commit("i1", base, { "a.txt": "one" }, "one");
		expect(await store.readFile("i1", "main", "a.txt")).toBe("one");
		expect(await store.readFile("i2", "main", "a.txt")).toBe("base");
		expect(await store.readFile("trunk", "main", "a.txt")).toBe("base");
		await expect(store.fork("trunk", "i1")).rejects.toThrow(/already exists/);
	});

	it("throws StaleHeadError with the actual head", async () => {
		const store = new MemoryRepoStore({ trunk: { "a.txt": "base" } });
		const base = await store.head("trunk");
		const next = await store.commit("trunk", base, { "a.txt": "next" }, "next");
		const error = await store.commit("trunk", base, { "a.txt": "late" }, "late").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(StaleHeadError);
		expect((error as StaleHeadError).actual).toBe(next);
	});

	it("skips files over 1 MB in snapshot but still lists them", async () => {
		const store = new MemoryRepoStore({ trunk: { "small.txt": "s", "big.txt": "x".repeat(1024 * 1024 + 1) } });
		expect(Object.keys(await store.snapshot("trunk", "main"))).toEqual(["small.txt"]);
		expect(await store.listFiles("trunk", "main")).toEqual(["big.txt", "small.txt"]);
	});

	it("rejects unknown repos and refs", async () => {
		const store = new MemoryRepoStore({ trunk: { "a.txt": "a" } });
		await expect(store.head("nope")).rejects.toThrow(/repo not found/);
		await expect(store.readFile("trunk", "f".repeat(40), "a.txt")).rejects.toThrow(/ref not found/);
		await expect(store.readFile("trunk", "some-branch", "a.txt")).rejects.toThrow(/ref not found/);
	});

	it("exposes a resettable singleton for REPO_STORE=memory", async () => {
		const seeded = resetMemoryStore({ trunk: { "a.txt": "a" } });
		expect(getMemoryStore()).toBe(seeded);
		expect(await getMemoryStore().readFile("trunk", "main", "a.txt")).toBe("a");
		expect(resetMemoryStore()).not.toBe(seeded);
	});
});
