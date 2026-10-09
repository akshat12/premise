import { describe, expect, it } from "vitest";
import type { TaskDef } from "../../shared/types";
import { DEMO_REPO_FILES } from "./demo-seed";
import { MemoryRepoStore } from "./memory-repo-store";

describe("DEMO_REPO_FILES", () => {
	const paths = Object.keys(DEMO_REPO_FILES);

	it("bundles the demo repo's source, tests and premise files", () => {
		expect(paths).toContain("src/auth/session.ts");
		expect(paths).toContain("tests/session.test.ts");
		expect(paths).toContain("premise/assert.ts");
		expect(paths).toContain("premise/reference/t01.patch.ts");
		expect(paths).toContain("premise/hidden-tests/t02-audit-expired.test.ts");
		expect(paths).toContain("package.json");
		expect(paths).toContain("tsconfig.json");
		expect(paths.filter((path) => path.startsWith("src/")).length).toBeGreaterThanOrEqual(35);
		expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
	});

	it("holds real file text, not module wrappers", () => {
		expect(DEMO_REPO_FILES["src/auth/session.ts"]).toContain("export function verifySession(");
		expect(DEMO_REPO_FILES["src/auth/session.ts"]).toContain("Throws SessionExpiredError when the session is expired");
	});

	it("has 12 tasks whose acceptance tests are not on trunk yet", () => {
		const tasks = JSON.parse(DEMO_REPO_FILES["premise/tasks.json"] ?? "[]") as TaskDef[];
		expect(tasks).toHaveLength(12);
		expect(new Set(tasks.map((task) => task.id)).size).toBe(12);
		for (const task of tasks) {
			expect(task.acceptance.length).toBeGreaterThan(0);
			for (const check of task.acceptance) {
				expect(paths).not.toContain(check.testFile);
			}
		}
	});

	it("seeds a MemoryRepoStore trunk", async () => {
		const store = new MemoryRepoStore({ trunk: DEMO_REPO_FILES });
		expect(await store.listFiles("trunk", "main")).toEqual([...paths].sort());
		expect(await store.readFile("trunk", "main", "premise/assertions.json")).toContain("a-session-throws");
	});
});
