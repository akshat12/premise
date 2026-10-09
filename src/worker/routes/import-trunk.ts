import { getRepoStore } from "../ports";
import { isArtifactsError } from "../ports/artifacts-repo-store";

export type RepoStatus = "ready" | "importing" | "forking" | "missing";

/** Calls `status()` until it says "ready", waiting `delayMs` between tries. Returns the last status seen. */
export async function pollUntilReady(
	status: () => Promise<RepoStatus>,
	options: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ status: RepoStatus; tries: number }> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let last: RepoStatus = "missing";
	for (let tries = 1; tries <= options.attempts; tries++) {
		last = await status();
		if (last === "ready") {
			return { status: last, tries };
		}
		if (tries < options.attempts) {
			await sleep(options.delayMs);
		}
	}
	return { status: last, tries: options.attempts };
}

/** Looks a repo up in the namespace listing, which is the only place its status is reported. */
async function repoStatus(artifacts: Artifacts, name: string): Promise<RepoStatus> {
	let cursor: string | undefined;
	do {
		const page = await artifacts.list({ limit: 100, cursor });
		const found = page.repos.find((repo) => repo.name === name) as { status?: RepoStatus } | undefined;
		if (found !== undefined) {
			return found.status ?? "ready";
		}
		cursor = page.cursor;
	} while (cursor);
	return "missing";
}

const ALREADY_EXISTS = { codes: ["ALREADY_EXISTS"], message: /already exists/i };

/**
 * POST /api/admin/import-trunk. Imports the public demo repo from GitHub into Artifacts as trunk.
 * Body (optional JSON): `{ "url": "https://github.com/...", "replace": true }`.
 * `replace` deletes an existing trunk first. In memory mode there is nothing to import: trunk is
 * the bundled copy of demo-repo/.
 */
export async function importTrunk(request: Request, env: Env): Promise<Response> {
	const body = ((await request.json().catch(() => null)) ?? {}) as { url?: unknown; replace?: unknown };
	const name = env.TRUNK_REPO;
	const store = getRepoStore(env);

	if (env.REPO_STORE === "memory") {
		return Response.json({ ok: true, store: "memory", repo: name, status: "ready", head: await store.head(name), files: (await store.listFiles(name, "main")).length });
	}

	const url = typeof body.url === "string" ? body.url : env.DEMO_REPO_URL;
	if (!/^https:\/\/\S+$/.test(url)) {
		return Response.json({ ok: false, error: "source url must be an https:// git URL; set DEMO_REPO_URL or pass { url }" }, { status: 400 });
	}

	const start = Date.now();
	if (body.replace === true) {
		await env.ARTIFACTS.delete(name).catch(() => false);
	}
	try {
		await env.ARTIFACTS.import({ source: { url, branch: "main" }, target: { name } });
	} catch (error) {
		if (isArtifactsError(error, ALREADY_EXISTS)) {
			return Response.json({ ok: false, error: `repo "${name}" already exists; pass { "replace": true } to delete it and import again` }, { status: 409 });
		}
		throw error;
	}

	const polled = await pollUntilReady(() => repoStatus(env.ARTIFACTS, name), { attempts: 60, delayMs: 1000 });
	if (polled.status !== "ready") {
		return Response.json({ ok: false, repo: name, status: polled.status, url, ms: Date.now() - start }, { status: 504 });
	}
	return Response.json({
		ok: true,
		store: "artifacts",
		repo: name,
		status: polled.status,
		url,
		head: await store.head(name),
		files: (await store.listFiles(name, "main")).length,
		ms: Date.now() - start,
	});
}
