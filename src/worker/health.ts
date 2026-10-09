export interface Health {
	ok: true;
	store: string;
	llm: string;
}

/** Body of `GET /api/health`: which RepoStore and LLM adapters this deployment uses. */
export function healthBody(env: { REPO_STORE: string; LLM: string }): Health {
	return { ok: true, store: env.REPO_STORE, llm: env.LLM };
}
