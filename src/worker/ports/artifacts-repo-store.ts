import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { CommitSha } from "../../shared/types";
import { createGitFs } from "./git-fs";
import { diffTrees, limitConcurrency, mapLimit, type ReadTree, walkTree } from "./git-tree";
import {
	DEFAULT_AUTHOR,
	type FileChanges,
	type FileMap,
	isCommitSha,
	MAX_SNAPSHOT_FILE_BYTES,
	type RepoStore,
	StaleHeadError,
	ZERO_SHA,
} from "./repo-store";

// 2,000 git requests per 10 s per repo: never run more than this many tree or blob reads at once.
const MAX_PARALLEL_READS = 16;
const WRITE_TOKEN_TTL_SECONDS = 600;
const WORKDIR = "/repo";

// The binding throws an ArtifactsError with a string `.code`. Through the remote binding in local
// dev, the same failure arrives as a plain Error whose message starts with "ArtifactsError: ..."
// and has no code, so match on either.
const ALREADY_EXISTS = { codes: ["ALREADY_EXISTS"], message: /already exists/i };
const NOT_READY = {
	codes: ["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"],
	message: /in progress|not ready|still (forking|importing|creating)/i,
};

export function isArtifactsError(error: unknown, kind: { codes: string[]; message: RegExp }): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string") {
		return kind.codes.includes(code);
	}
	return error instanceof Error && kind.message.test(error.message);
}

/** Tokens look like art_v1_<40hex>?expires=<unix>. Git Basic auth wants only the secret part. */
function authFor(token: string) {
	const password = token.split("?expires=")[0] ?? token;
	return () => ({ username: "x", password });
}

/** RepoStore on real Artifacts: reads through the binding, writes through isomorphic-git. */
export class ArtifactsRepoStore implements RepoStore {
	private artifacts: Artifacts;

	constructor(env: Pick<Env, "ARTIFACTS">) {
		this.artifacts = env.ARTIFACTS;
	}

	/** `get()` throws while a repo is still forking or being created, so retry briefly. */
	private async open(name: string): Promise<ArtifactsRepo> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.artifacts.get(name);
			} catch (error) {
				const pending = isArtifactsError(error, NOT_READY);
				if (!pending || attempt >= 40) {
					throw error;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		}
	}

	private static async headOf(repo: ArtifactsRepo): Promise<CommitSha> {
		const [latest] = await repo.log({ ref: "main", limit: 1 });
		return latest?.hash ?? ZERO_SHA;
	}

	/** Tree hash at a ref (branch name or commit sha). null when the repo has no commits. */
	private static async treeAt(repo: ArtifactsRepo, ref: string): Promise<string | null> {
		if (ref === ZERO_SHA) {
			return null;
		}
		if (isCommitSha(ref)) {
			const commit = await repo.readCommit(ref);
			if (commit === null) {
				throw new Error(`commit not found: ${ref}`);
			}
			return commit.treeHash;
		}
		const [latest] = await repo.log({ ref, limit: 1 });
		return latest?.treeHash ?? null;
	}

	private static treeReader(repo: ArtifactsRepo): ReadTree {
		return limitConcurrency((hash) => repo.readTree(hash), MAX_PARALLEL_READS);
	}

	async ensureRepo(name: string): Promise<void> {
		try {
			await this.artifacts.create(name, { setDefaultBranch: "main" });
		} catch (error) {
			if (!isArtifactsError(error, ALREADY_EXISTS)) {
				throw error;
			}
		}
	}

	async fork(source: string, target: string): Promise<{ head: CommitSha }> {
		{
			using from = await this.open(source);
			await from.fork(target, { defaultBranchOnly: true });
		}
		using fork = await this.open(target);
		return { head: await ArtifactsRepoStore.headOf(fork) };
	}

	async head(repo: string): Promise<CommitSha> {
		using handle = await this.open(repo);
		return await ArtifactsRepoStore.headOf(handle);
	}

	async readFile(repo: string, ref: string, path: string): Promise<string | null> {
		if (ref === ZERO_SHA) {
			return null;
		}
		using handle = await this.open(repo);
		const blob = await handle.readFile({ ref, path });
		return blob === null ? null : await blob.text();
	}

	async listFiles(repo: string, ref: string): Promise<string[]> {
		using handle = await this.open(repo);
		const tree = await ArtifactsRepoStore.treeAt(handle, ref);
		const files = await walkTree(ArtifactsRepoStore.treeReader(handle), tree);
		return files.map((file) => file.path);
	}

	async snapshot(repo: string, ref: string): Promise<FileMap> {
		using handle = await this.open(repo);
		const tree = await ArtifactsRepoStore.treeAt(handle, ref);
		const files = await walkTree(ArtifactsRepoStore.treeReader(handle), tree);
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
		const contents = await mapLimit(files, MAX_PARALLEL_READS, async (file): Promise<[string, string] | null> => {
			if (file.type !== "blob" && file.type !== "exec") {
				return null;
			}
			// readBlob returns an untyped Blob, so decode the bytes ourselves.
			const blob = await handle.readBlob(file.hash);
			if (blob === null || blob.size > MAX_SNAPSHOT_FILE_BYTES) {
				return null;
			}
			try {
				return [file.path, decoder.decode(await blob.arrayBuffer())];
			} catch {
				return null; // not valid UTF-8: a binary file
			}
		});
		return Object.fromEntries(contents.filter((entry) => entry !== null));
	}

	async commit(
		repo: string,
		expectedHead: CommitSha,
		changes: FileChanges,
		message: string,
		author: { name: string; email: string } = DEFAULT_AUTHOR,
	): Promise<CommitSha> {
		using handle = await this.open(repo);
		const current = await ArtifactsRepoStore.headOf(handle);
		if (current !== expectedHead) {
			throw new StaleHeadError(current);
		}

		const [info, token] = await Promise.all([handle.info(), handle.createToken("write", WRITE_TOKEN_TTL_SECONDS)]);
		const onAuth = authFor(token.plaintext);
		const fs = createGitFs();
		const dir = WORKDIR;

		if (expectedHead === ZERO_SHA) {
			await git.init({ fs, dir, defaultBranch: "main" });
		} else {
			// A shallow clone is enough to add one commit and push it (verified in T00).
			await git.clone({ fs, http, dir, url: info.remote, ref: "main", singleBranch: true, depth: 1, onAuth });
			const cloned = await git.resolveRef({ fs, dir, ref: "HEAD" });
			if (cloned !== expectedHead) {
				throw new StaleHeadError(cloned);
			}
		}

		for (const [path, content] of Object.entries(changes)) {
			if (content === null) {
				// Deleting a path that is not there is a no-op, as in MemoryRepoStore.
				const exists = await fs.promises.stat(`${dir}/${path}`).then(() => true, () => false);
				if (exists) {
					await fs.promises.unlink(`${dir}/${path}`);
					await git.remove({ fs, dir, filepath: path });
				}
			} else {
				await fs.promises.writeFile(`${dir}/${path}`, content);
				await git.add({ fs, dir, filepath: path });
			}
		}
		const sha = await git.commit({ fs, dir, message, author });

		try {
			await git.push({ fs, http, dir, url: info.remote, ref: "main", onAuth });
		} catch (error) {
			// Someone else pushed between our clone and our push.
			const actual = await ArtifactsRepoStore.headOf(handle);
			if (actual !== expectedHead && actual !== sha) {
				throw new StaleHeadError(actual);
			}
			throw error;
		}
		return sha;
	}

	async changedPaths(repo: string, from: CommitSha, to: CommitSha): Promise<string[]> {
		using handle = await this.open(repo);
		const [before, after] = await Promise.all([
			ArtifactsRepoStore.treeAt(handle, from),
			ArtifactsRepoStore.treeAt(handle, to),
		]);
		// `await` here matters: `using` releases the handle when this function returns.
		return await diffTrees(ArtifactsRepoStore.treeReader(handle), before, after);
	}

	async remove(repo: string): Promise<void> {
		await this.artifacts.delete(repo);
	}
}
