// Smoke test against a DEPLOYED Premise Worker. Usage: PREMISE_URL=https://... npm run smoke
const base = process.env.PREMISE_URL;
if (!base) {
	console.error("Set PREMISE_URL to the deployed Worker URL, e.g. https://premise.<subdomain>.workers.dev");
	process.exit(1);
}

const response = await fetch(new URL("/api/health", base));
const body: unknown = await response.json();
console.log(response.status, JSON.stringify(body));
if (!response.ok || (body as { ok?: boolean }).ok !== true) {
	process.exit(1);
}
