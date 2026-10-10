import { isEventBody } from "../../shared/wire";
import { isAdminRequest } from "../admin-auth";
import { hub, publish } from "../hub/publish";
import { getRepoStore } from "../ports";
import { ArtifactsRepoStore } from "../ports/artifacts-repo-store";
import { runContract } from "../ports/repo-store.contract";
import { analyze } from "../surface";
import { importTrunk } from "./import-trunk";

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
	if (request.method !== "POST") {
		return Response.json({ error: "method not allowed" }, { status: 405 });
	}
	switch (url.pathname) {
		case "/api/admin/smoke":
			return smoke(env);
		case "/api/admin/analyze": {
			// Typechecks trunk and counts its symbols with the TypeScript compiler, inside this Worker.
			const files = await getRepoStore(env).snapshot(env.TRUNK_REPO, "main");
			const result = analyze(files);
			return Response.json({
				ok: result.typecheck.ok,
				errors: result.typecheck.errors.slice(0, 20),
				files: Object.keys(files).length,
				symbols: result.surface.size,
				verifySession: result.surface.get("src/auth/session.ts#verifySession") ?? null,
				ms: result.ms,
			});
		}
		case "/api/admin/import-trunk":
			return importTrunk(request, env);
		case "/api/admin/events/reset":
			await hub(env).reset();
			return Response.json({ ok: true });
		case "/api/admin/events/fake": {
			// Publishes whatever event body is posted. For UI testing.
			const body: unknown = await request.json().catch(() => null);
			if (!isEventBody(body)) {
				return Response.json({ error: "body must be a PremiseEventBody with a known `t`" }, { status: 400 });
			}
			return Response.json(await publish(env, body));
		}
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
