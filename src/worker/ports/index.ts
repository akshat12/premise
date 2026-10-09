import { ArtifactsRepoStore } from "./artifacts-repo-store";
import { getMemoryStore } from "./memory-repo-store";
import type { RepoStore } from "./repo-store";

export type { FileChanges, FileMap, RepoStore } from "./repo-store";
export { StaleHeadError, ZERO_SHA } from "./repo-store";

/** The RepoStore this deployment is configured for (`REPO_STORE` = "artifacts" | "memory"). */
export function getRepoStore(env: Pick<Env, "REPO_STORE" | "ARTIFACTS">): RepoStore {
	switch (env.REPO_STORE) {
		case "memory":
			return getMemoryStore();
		case "artifacts":
			return new ArtifactsRepoStore(env);
		default:
			throw new Error(`REPO_STORE must be "artifacts" or "memory", got "${env.REPO_STORE}"`);
	}
}
