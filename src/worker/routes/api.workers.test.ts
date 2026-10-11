import { listDurableObjectIds } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newIntentId } from "../../shared/ids";
import type { Intent } from "../../shared/types";
import type { IntentDiff } from "../diff/intent-diff";
import { currentTrunk, hub } from "../hub/publish";
import { type IntentApi, intentStub, newIntent } from "../intent/client";
import { getRepoStore } from "../ports";

const fetchApi = (path: string) => exports.default.fetch(`http://premise.test${path}`);
const SESSION = "src/auth/session.ts";

/** Forks trunk and creates an Intent on the fork, as dispatch does, without starting an agent. */
async function startIntent(): Promise<{ id: string; api: IntentApi; intent: Intent }> {
	const store = getRepoStore(env);
	const id = newIntentId();
	const { head } = await store.fork(await currentTrunk(env), id);
	const api = intentStub(env, id);
	const intent = await api.init(newIntent({ id, kind: "agent", taskId: "t07-role-check", goal: "A test of the diff route", acceptance: [], baseCommit: head }));
	return { id, api, intent };
}

/** Commits to the Intent's fork and records the push, as the agent's submit step does. */
async function push(intent: Intent, api: IntentApi, changes: Record<string, string | null>): Promise<string> {
	const commit = await getRepoStore(env).commit(intent.repo, intent.headCommit ?? intent.baseCommit, changes, `intent ${intent.id}: test`);
	await api.setHead(commit);
	return commit;
}

async function diffOf(id: string): Promise<{ response: Response; diff: IntentDiff }> {
	const response = await fetchApi(`/api/intents/${id}/diff`);
	expect(response.status).toBe(200);
	return { response, diff: (await response.json()) as IntentDiff };
}

const marks = (diff: IntentDiff, path: string) => (diff.files.find((file) => file.path === path)?.hunks ?? []).flatMap((hunk) => hunk.lines).filter((line) => line.kind !== " ").map((line) => `${line.kind}${line.text}`);

describe("GET /api/intents/:id", () => {
	it("answers 404 for an id that is not an Intent's, without creating a Durable Object for it", async () => {
		const before = (await listDurableObjectIds(env.INTENT)).length;
		for (const id of ["i00000000", "izzzzzzzz", "nope", "i123", "I3K9X0A2Q", "i3k9x0a2q-r1", "%2e%2e%2fadmin", "i3k9x0a2%71", "x".repeat(500)]) {
			for (const suffix of ["", "/diff"]) {
				const response = await fetchApi(`/api/intents/${id}${suffix}`);
				expect(response.status, `${id}${suffix}`).toBe(404);
				expect(await response.json()).toEqual({ error: "no such Intent" });
			}
		}
		expect((await listDurableObjectIds(env.INTENT)).length).toBe(before);

		// The check is worth having: asking the namespace directly does create one.
		await intentStub(env, "i00000000").get().catch(() => null);
		expect((await listDurableObjectIds(env.INTENT)).length).toBe(before + 1);
	});

	it("returns a known Intent, and 404 for anything under it but /diff", async () => {
		const { id, api } = await startIntent();
		expect(await hub(env).knows(id)).toBe(true);
		const response = await fetchApi(`/api/intents/${id}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id, status: "planning", repo: id });
		const other = await fetchApi(`/api/intents/${id}/overlay`);
		expect(other.status).toBe(404);
		await other.text();
		await api.act({ a: "fail" }, "test over");
	});
});

describe("GET /api/intents/:id/diff", () => {
	it("is empty before the Intent has done anything", async () => {
		const { id, api, intent } = await startIntent();
		const { diff } = await diffOf(id);
		expect(diff).toEqual({ intentId: id, base: intent.baseCommit, head: null, files: [], fileCount: 0 });
		await api.act({ a: "fail" }, "test over");
	});

	it("shows staged edits while nothing is pushed, and does not let them be cached", async () => {
		const { id, api, intent } = await startIntent();
		await api.writeOverlay("src/new-file.ts", "export const added = 1;\n");
		await api.writeOverlay("README.md", null);
		await api.writeOverlay(".intent/notes.md", "not for review\n");
		const { response, diff } = await diffOf(id);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(diff).toMatchObject({ intentId: id, base: intent.baseCommit, head: null, staged: true, fileCount: 2 });
		expect(diff.files.map((file) => [file.path, file.status])).toEqual([
			["README.md", "deleted"],
			["src/new-file.ts", "added"],
		]);
		expect(marks(diff, "src/new-file.ts")).toEqual(["+export const added = 1;"]);
		await api.act({ a: "fail" }, "test over");
	});

	it("compares the fork at its base with what was pushed", async () => {
		const { id, api, intent } = await startIntent();
		const store = getRepoStore(env);
		const session = (await store.readFile(intent.repo, intent.baseCommit, SESSION)) ?? "";
		expect(session).toContain("export function verifySession(");
		const commit = await push(intent, api, {
			[SESSION]: session.replace("export function verifySession(", "// reviewed\nexport function verifySession("),
			"src/review/added.ts": "export const one = 1;\nexport const two = 2;\n",
			".intent/record.json": "{}\n",
		});

		const { response, diff } = await diffOf(id);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=5");
		expect(diff).toMatchObject({ intentId: id, base: intent.baseCommit, head: commit, fileCount: 2 });
		expect(diff.staged).toBeUndefined();
		expect(diff.files.map((file) => [file.path, file.status])).toEqual([
			[SESSION, "modified"],
			["src/review/added.ts", "added"],
		]);
		expect(marks(diff, SESSION)).toEqual(["+// reviewed"]);
		// One hunk: the new line with three lines of context on each side.
		const [hunk] = diff.files[0]?.hunks ?? [];
		expect(diff.files[0]?.hunks).toHaveLength(1);
		expect(hunk?.lines.map((line) => line.kind).join("")).toBe("   +   ");
		expect(hunk?.newStart).toBe(hunk?.oldStart);
		expect(diff.files[1]?.hunks).toEqual([{ oldStart: 0, newStart: 1, lines: [{ kind: "+", text: "export const one = 1;" }, { kind: "+", text: "export const two = 2;" }] }]);

		// A second push moves the head, and the diff with it.
		const again = await push({ ...intent, headCommit: commit }, api, { "src/review/added.ts": null });
		const second = (await diffOf(id)).diff;
		expect(second.head).toBe(again);
		expect(second.files.map((file) => file.path)).toEqual([SESSION]);
		await api.act({ a: "fail" }, "test over");
	});

	it("still shows a landed Intent's own work, though its head is then a trunk commit", async () => {
		const { id, api, intent } = await startIntent();
		const forkCommit = await push(intent, api, { "src/review/landed.ts": "export const landed = true;\n" });
		for (const action of [{ a: "claim" }, { a: "granted" }, { a: "submit", commit: forkCommit }, { a: "check" }, { a: "queue" }, { a: "gate" }] as const) {
			await api.act(action);
		}
		// What the gate records on landing is the commit it made on trunk, which the fork does not have.
		const trunkCommit = "d".repeat(40);
		expect((await api.act({ a: "land", commit: trunkCommit })).headCommit).toBe(trunkCommit);

		const { diff } = await diffOf(id);
		expect(diff).toMatchObject({ intentId: id, head: forkCommit, fileCount: 1 });
		expect(diff.unavailable).toBeUndefined();
		expect(marks(diff, "src/review/landed.ts")).toEqual(["+export const landed = true;"]);
	});

	it("caps the response at 40 files and 400 changed lines a file", async () => {
		const { id, api, intent } = await startIntent();
		const long = Array.from({ length: 450 }, (_, index) => `export const n${index} = ${index};\n`).join("");
		const files = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`src/many/f${String(index).padStart(2, "0")}.ts`, index === 0 ? long : `export const f${index} = ${index};\n`]));
		await push(intent, api, files);
		const { diff } = await diffOf(id);
		expect(diff).toMatchObject({ fileCount: 45, truncated: true });
		expect(diff.files).toHaveLength(40);
		expect(diff.files[0]).toMatchObject({ path: "src/many/f00.ts", truncated: true });
		expect(marks(diff, "src/many/f00.ts")).toHaveLength(400);
		expect(diff.files[1]?.truncated).toBeUndefined();
		await api.act({ a: "fail" }, "test over");
	});

	it("says so when the fork can no longer be read", async () => {
		const { id, api, intent } = await startIntent();
		await push(intent, api, { "src/review/gone.ts": "export const gone = 1;\n" });
		await getRepoStore(env).remove(intent.repo);
		const { response, diff } = await diffOf(id);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(diff).toEqual({ intentId: id, base: intent.baseCommit, head: null, files: [], fileCount: 0, unavailable: true });
		await api.act({ a: "fail" }, "test over");
	});
});

describe("public reads of the repo", () => {
	it("may be cached for five seconds", async () => {
		for (const path of ["/api/tasks", "/api/trunk"]) {
			const response = await fetchApi(path);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("public, max-age=5");
			await response.text();
		}
	});

	it("answer /api/trunk and /api/tasks from memory until the trunk they name changes", async () => {
		const store = getRepoStore(env);
		const trunk = await currentTrunk(env);
		const first = (await (await fetchApi("/api/trunk")).json()) as { repo: string; head: string };
		expect(first).toEqual({ repo: trunk, head: expect.stringMatching(/^[0-9a-f]{40}$/) });
		const tasks = (await (await fetchApi("/api/tasks")).json()) as { id: string }[];
		expect(tasks.length).toBeGreaterThan(0);

		// Trunk moves. For the next few seconds the routes answer as before, without reading the repo.
		const original = (await store.readFile(trunk, first.head, "premise/tasks.json")) ?? "";
		const moved = await store.commit(trunk, await store.head(trunk), { "premise/tasks.json": "[]\n" }, "test: empty the task list");
		expect(moved).not.toBe(first.head);
		expect(await (await fetchApi("/api/trunk")).json()).toEqual(first);
		expect(await (await fetchApi("/api/tasks")).json()).toEqual(tasks);

		// Put the file back exactly as it was, for the tests that run after this one.
		await store.commit(trunk, moved, { "premise/tasks.json": original }, "test: restore the task list");
		expect(await store.readFile(trunk, "main", "premise/tasks.json")).toBe(original);
	});
});
