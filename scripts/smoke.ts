// Smoke test against a running Premise Worker (normally the DEPLOYED one).
//   PREMISE_URL=https://premise.<subdomain>.workers.dev npm run smoke
// The admin token comes from the ADMIN_TOKEN environment variable, or else from `.env.deployed`
// (the deployed Worker's token, git-ignored), or else from `.dev.vars` (the local dev token), so
// the secret never has to be typed on a command line.
import { existsSync, readFileSync } from "node:fs";

function adminToken(): string | undefined {
	if (process.env.ADMIN_TOKEN) {
		return process.env.ADMIN_TOKEN;
	}
	for (const file of [".env.deployed", ".dev.vars"]) {
		if (!existsSync(file)) {
			continue;
		}
		const line = readFileSync(file, "utf8")
			.split("\n")
			.find((entry) => entry.startsWith("ADMIN_TOKEN="));
		const value = line?.slice("ADMIN_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
		if (value) {
			return value;
		}
	}
	return undefined;
}

const base = process.env.PREMISE_URL;
if (!base) {
	console.error("Set PREMISE_URL to the Worker URL, e.g. https://premise.<subdomain>.workers.dev");
	process.exit(1);
}

let failed = false;

const health = await fetch(new URL("/api/health", base));
const healthBody = (await health.json()) as { ok?: boolean };
console.log(`health   ${health.status} ${JSON.stringify(healthBody)}`);
failed ||= !health.ok || healthBody.ok !== true;

const token = adminToken();
if (!token) {
	console.error("No ADMIN_TOKEN in the environment or in .dev.vars; cannot run the Artifacts contract.");
	process.exit(1);
}

interface SmokeBody {
	ok: boolean;
	ms: number;
	results: { name: string; ok: boolean; error?: string; ms: number }[];
	swept: string[];
	error?: string;
}

const smoke = await fetch(new URL("/api/admin/smoke", base), { method: "POST", headers: { "x-admin-token": token } });
if (smoke.status === 401) {
	console.error("smoke    401 unauthorized: ADMIN_TOKEN does not match the Worker's secret.");
	process.exit(1);
}
const body = (await smoke.json()) as SmokeBody;
console.log(`smoke    ${smoke.status} RepoStore contract against real Artifacts (${body.ms} ms)`);
for (const result of body.results ?? []) {
	console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name} (${result.ms} ms)${result.error ? `\n        ${result.error}` : ""}`);
}
if (body.swept?.length) {
	console.log(`  swept leftover repos: ${body.swept.join(", ")}`);
}
failed ||= !smoke.ok || body.ok !== true;

const passed = (body.results ?? []).filter((result) => result.ok).length;
console.log(`${passed}/${body.results?.length ?? 0} contract cases passed`);
process.exit(failed ? 1 : 0);
