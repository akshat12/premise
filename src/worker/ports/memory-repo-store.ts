import type { CommitSha } from "../../shared/types";
import {
	type FileChanges,
	type FileMap,
	isCommitSha,
	MAX_SNAPSHOT_FILE_BYTES,
	type RepoStore,
	StaleHeadError,
	ZERO_SHA,
} from "./repo-store";

interface MemoryCommit {
	parent: CommitSha;
	files: FileMap;
}

interface MemoryRepo {
	commits: Map<CommitSha, MemoryCommit>;
	main: CommitSha;
}

function sortedFiles(files: FileMap): FileMap {
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function sha1Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Commit sha = SHA-1 of parent + sorted files + message. Deterministic, so tests can predict nothing but rely on equality. */
export function memoryCommitSha(parent: CommitSha, files: FileMap, message: string): Promise<CommitSha> {
	return sha1Hex(parent + JSON.stringify(sortedFiles(files)) + message);
}

export function applyChanges(files: FileMap, changes: FileChanges): FileMap {
	const next: FileMap = { ...files };
	for (const [path, content] of Object.entries(changes)) {
		if (content === null) {
			delete next[path];
		} else {
			next[path] = content;
		}
	}
	return next;
}

export function diffFileMaps(from: FileMap, to: FileMap): string[] {
	const paths = new Set([...Object.keys(from), ...Object.keys(to)]);
	return [...paths].filter((path) => from[path] !== to[path]).sort();
}

/** In-memory RepoStore for tests and for `REPO_STORE=memory` local dev. */
export class MemoryRepoStore implements RepoStore {
	private repos = new Map<string, MemoryRepo>();
	private seeding: Promise<void>;

	/** `new MemoryRepoStore({ trunk: files })` creates each named repo with one commit. */
	constructor(seed: Record<string, FileMap> = {}) {
		this.seeding = this.applySeed(seed);
	}

	private async applySeed(seed: Record<string, FileMap>): Promise<void> {
		for (const [name, files] of Object.entries(seed)) {
			const message = "seed";
			const sha = await memoryCommitSha(ZERO_SHA, files, message);
			this.repos.set(name, { commits: new Map([[sha, { parent: ZERO_SHA, files: sortedFiles(files) }]]), main: sha });
		}
	}

	private async repo(name: string): Promise<MemoryRepo> {
		await this.seeding;
		const repo = this.repos.get(name);
		if (!repo) {
			throw new Error(`repo not found: ${name}`);
		}
		return repo;
	}

	private async filesAt(name: string, ref: string): Promise<FileMap> {
		const repo = await this.repo(name);
		const sha = ref === "main" || ref === "HEAD" || ref === "refs/heads/main" ? repo.main : ref;
		if (sha === ZERO_SHA) {
			return {};
		}
		const commit = isCommitSha(sha) ? repo.commits.get(sha) : undefined;
		if (!commit) {
			throw new Error(`ref not found in ${name}: ${ref}`);
		}
		return commit.files;
	}

	async ensureRepo(name: string): Promise<void> {
		await this.seeding;
		if (!this.repos.has(name)) {
			this.repos.set(name, { commits: new Map(), main: ZERO_SHA });
		}
	}

	async fork(source: string, target: string): Promise<{ head: CommitSha }> {
		const from = await this.repo(source);
		if (this.repos.has(target)) {
			throw new Error(`repo already exists: ${target}`);
		}
		// Commits are never mutated after creation, so a shallow copy of the map is an independent fork.
		this.repos.set(target, { commits: new Map(from.commits), main: from.main });
		return { head: from.main };
	}

	async head(repo: string): Promise<CommitSha> {
		return (await this.repo(repo)).main;
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | null> {
		return (await this.filesAt(repo, ref))[path] ?? null;
	}

	async listFiles(repo: string, ref: string): Promise<string[]> {
		return Object.keys(await this.filesAt(repo, ref)).sort();
	}

	async snapshot(repo: string, ref: string): Promise<FileMap> {
		const encoder = new TextEncoder();
		const files = await this.filesAt(repo, ref);
		return Object.fromEntries(
			Object.entries(files).filter(([, content]) => encoder.encode(content).byteLength <= MAX_SNAPSHOT_FILE_BYTES),
		);
	}

	async commit(repo: string, expectedHead: CommitSha, changes: FileChanges, message: string): Promise<CommitSha> {
		const target = await this.repo(repo);
		if (target.main !== expectedHead) {
			throw new StaleHeadError(target.main);
		}
		const files = sortedFiles(applyChanges(await this.filesAt(repo, expectedHead), changes));
		const sha = await memoryCommitSha(expectedHead, files, message);
		target.commits.set(sha, { parent: expectedHead, files });
		target.main = sha;
		return sha;
	}

	async changedPaths(repo: string, from: CommitSha, to: CommitSha): Promise<string[]> {
		return diffFileMaps(await this.filesAt(repo, from), await this.filesAt(repo, to));
	}

	async remove(repo: string): Promise<void> {
		await this.seeding;
		this.repos.delete(repo);
	}
}

let singleton: MemoryRepoStore | undefined;

/**
 * Process-wide store for `REPO_STORE=memory`. State lives in one isolate and is lost on reload,
 * which is fine for local dev and tests but is never used when deployed.
 * `seed` is only called the first time, to fill the new store.
 */
export function getMemoryStore(seed?: () => Record<string, FileMap>): MemoryRepoStore {
	singleton ??= new MemoryRepoStore(seed?.());
	return singleton;
}

/** Tests only: drop the singleton so each test starts clean. */
export function resetMemoryStore(seed?: Record<string, FileMap>): MemoryRepoStore {
	singleton = new MemoryRepoStore(seed);
	return singleton;
}
