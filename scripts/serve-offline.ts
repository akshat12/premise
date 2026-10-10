// Serves the built UI (dist/client) as plain files, with no Worker and no network: the stage
// fallback. The recorded run plays at /?demo=main because a replay needs no backend.
//
//   npm run demo:offline            # builds, then serves http://localhost:4173/?demo=main
//   npx tsx scripts/serve-offline.ts [--port 4173]    # serves what is already built
//
// `vite preview` is not used for this: it starts the Worker, whose Artifacts binding needs a
// Cloudflare login and a network connection.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { arg } from "./lib/admin";

const root = resolve("dist/client");
const port = Number(arg("port", "4173"));
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
};

if (!existsSync(join(root, "index.html"))) {
	throw new Error("dist/client/index.html is missing. Run `npm run build` first (or `npm run demo:offline`, which builds).");
}

createServer((request, response) => {
	const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
	const wanted = join(root, path);
	// Anything that is not a file inside dist/client gets the app itself, as on the deployed Worker.
	const file = wanted.startsWith(root) && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(root, "index.html");
	response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
	createReadStream(file).pipe(response);
}).listen(port, "127.0.0.1", () => {
	console.log(`Serving the built app with no backend: http://localhost:${port}/?demo=main`);
	console.log("Live mode and dispatching need a Worker; the recorded run does not.");
});
