import { isAdminRequest } from "../admin-auth";
import { ArtifactsRepoStore } from "../ports/artifacts-repo-store";
import { runContract } from "../ports/repo-store.contract";

const SMOKE_PREFIX = "smoke";

/** Deletes any `smoke-*` repos a crashed run left behind. */
async function sweepSmokeRepos(artifacts: Artifacts): Promise<string[]> {
	const deleted: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await artifacts.list({ limit: 100, cursor });
		for (const repo of page.repos) {
			if (repo.name.startsWith(`${SMOKE_PREFIX}-`) && (await artifacts.delete(repo.name))) {
				deleted.push(repo.name);
			}
		}
		cursor = page.cursor;
	} while (cursor);
	return deleted;
}

/** Runs the RepoStore contract against real Artifacts, whatever REPO_STORE is set to. */
async function smoke(env: Env): Promise<Response> {
	const start = Date.now();
	const results = await runContract(() => new ArtifactsRepoStore(env), { prefix: SMOKE_PREFIX, parallel: true });
	const swept = await sweepSmokeRepos(env.ARTIFACTS);
	const ok = results.every((result) => result.ok);
	return Response.json({ ok, ms: Date.now() - start, results, swept }, { status: ok ? 200 : 500 });
}

/** Routes under /api/admin/. Every one requires the `x-admin-token` header. */
export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
	if (!isAdminRequest(request, env)) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	if (url.pathname === "/api/admin/smoke" && request.method === "POST") {
		return smoke(env);
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
