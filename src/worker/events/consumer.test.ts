import { describe, expect, it } from "vitest";
import { intentFromMessage, interpret, isArtifactsEvent } from "./consumer";

const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);
const metadata = { accountId: "f9f79265f388666de8122cfb508d7776", eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f", eventSchemaVersion: 1, eventTimestamp: "2026-05-18T15:53:54.641Z" };

// The shapes below are the examples from Cloudflare's event schema reference, with our names in them.
const forked = {
	type: "cf.artifacts.repo.forked",
	source: { type: "artifacts", namespace: "premise", repoName: "trunk" },
	payload: { namespace: "premise", repoName: "i3k9x0a2q", repoId: "5ankv1vhl4xnw7wq", defaultBranch: "main", description: "Fork of trunk", readOnly: false, createdAt: "2026-05-18T15:53:52.384Z", updatedAt: "2026-05-18T15:53:54.579Z", lastPushAt: null },
	metadata,
};

const pushed = (message: string, overrides: { repoName?: string; ref?: string; after?: string } = {}) => ({
	type: "cf.artifacts.repo.pushed",
	source: { type: "artifacts.repo", namespace: "premise", repoName: overrides.repoName ?? "trunk" },
	payload: {
		ref: overrides.ref ?? "refs/heads/main",
		before: BEFORE,
		after: overrides.after ?? AFTER,
		commits: [{ id: overrides.after ?? AFTER, message, messageTruncated: false, timestamp: "2025-05-01T02:48:57.000Z", author: { name: "Dev", email: "dev@example.com" }, committer: { name: "Dev", email: "dev@example.com" }, parents: [BEFORE] }],
		totalCommitsCount: 1,
		commitsTruncated: false,
	},
	metadata,
});

const lifecycle = (kind: string, payload: Record<string, unknown> = {}) => ({ type: `cf.artifacts.repo.${kind}`, source: { type: "artifacts", namespace: "premise", repoName: "trunk-abc" }, payload: { repoId: "x", defaultBranch: "main", ...payload }, metadata });

describe("interpret", () => {
	it("relays a fork with the new repo's name and where it came from", () => {
		expect(interpret(forked, "trunk")).toEqual({ publish: [{ t: "artifacts", type: "repo.forked", repo: "i3k9x0a2q", detail: { source: "trunk" } }] });
	});

	it("treats a push to trunk's main branch as a trunk push, and names the Intent from the trailer", () => {
		const result = interpret(pushed("intent i3k9x0a2q: Round tax to even\n\nPremise-Intent: i3k9x0a2q\n"), "trunk");
		expect(result.trunkPush).toEqual({ before: BEFORE, after: AFTER, byIntent: "i3k9x0a2q" });
		expect(result.publish).toEqual([{ t: "artifacts", type: "repo.pushed", repo: "trunk", detail: { ref: "refs/heads/main", before: BEFORE, after: AFTER, intent: "i3k9x0a2q" } }]);
	});

	it("a push with no trailer came from outside the gate", () => {
		expect(interpret(pushed("Fix bug in authentication"), "trunk").trunkPush).toEqual({ before: BEFORE, after: AFTER, byIntent: null });
	});

	it("relays, but does not act on, pushes to other repos, other refs, or a deleted branch", () => {
		for (const event of [pushed("x", { repoName: "i3k9x0a2q" }), pushed("x", { ref: "refs/heads/experiment" }), pushed("x", { after: "not-a-sha" })]) {
			const result = interpret(event, "trunk");
			expect(result.trunkPush).toBeUndefined();
			expect(result.publish).toHaveLength(1);
			expect(result.publish[0]).toMatchObject({ t: "artifacts", type: "repo.pushed" });
		}
		// Trunk is whatever the current trunk is called, which changes when the demo is reset.
		expect(interpret(pushed("x"), "trunk-mv1tf732").trunkPush).toBeUndefined();
		expect(interpret(pushed("x", { repoName: "trunk-mv1tf732" }), "trunk-mv1tf732").trunkPush).toBeDefined();
	});

	it("relays created, imported and deleted for the UI", () => {
		expect(interpret(lifecycle("created"), "trunk").publish).toEqual([{ t: "artifacts", type: "repo.created", repo: "trunk-abc" }]);
		expect(interpret(lifecycle("deleted"), "trunk").publish).toEqual([{ t: "artifacts", type: "repo.deleted", repo: "trunk-abc" }]);
		expect(interpret(lifecycle("imported", { sourceUrl: "https://github.com/example/repo.git", branch: "main" }), "trunk").publish).toEqual([{ t: "artifacts", type: "repo.imported", repo: "trunk-abc", detail: { sourceUrl: "https://github.com/example/repo.git" } }]);
	});

	it("uses types the fork and push counters do not count, so nothing is counted twice", () => {
		const types = [forked, pushed("x"), lifecycle("created")].flatMap((event) => interpret(event, "trunk").publish).map((event) => (event.t === "artifacts" ? event.type : ""));
		expect(types).toEqual(["repo.forked", "repo.pushed", "repo.created"]);
		expect(types.some((type) => type === "forked" || type === "pushed")).toBe(false);
	});

	it("ignores everything else", () => {
		for (const body of [lifecycle("cloned"), lifecycle("token.created"), { type: "cf.r2.object.created" }, "hello", null, 42, {}]) {
			expect(interpret(body, "trunk")).toEqual({ publish: [] });
		}
	});
});

describe("helpers", () => {
	it("intentFromMessage reads the trailer the gate writes", () => {
		expect(intentFromMessage("intent iabc12345: goal\n\nPremise-Intent: iabc12345")).toBe("iabc12345");
		expect(intentFromMessage("intent iabc12345: goal\n\nPremise-Intent: iabc12345\n")).toBe("iabc12345");
		expect(intentFromMessage("Mentions Premise-Intent: nope in passing")).toBeNull();
		expect(intentFromMessage("")).toBeNull();
	});

	it("isArtifactsEvent checks the type prefix", () => {
		expect(isArtifactsEvent(forked)).toBe(true);
		expect(isArtifactsEvent({ type: "cf.workflows.instance.started" })).toBe(false);
		expect(isArtifactsEvent(undefined)).toBe(false);
	});
});
