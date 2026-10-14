import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
// The repository root, four folders up from this file (docs/video/deck/tools).
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
import { writeFileSync } from "node:fs";
const require = createRequire(resolve(root, "package.json"));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const P = await import(pathToFileURL(resolve(root, "node_modules/@phosphor-icons/react/dist/ssr/index.es.js")).href).catch(async () => import(pathToFileURL(resolve(root, "node_modules/@phosphor-icons/react/dist/index.es.js")).href));
const map = { Activity: "Activity", Book: "BookOpen", Chart: "ChartBar", Chat: "ChatCircle", Check: "Check", CheckCircle: "CheckCircle", Clock: "Clock", Cloud: "Cloud", Code: "Code", Database: "Database", Globe: "Globe", GraduationCap: "GraduationCap", Home: "House", Key: "Key", Lightbulb: "Lightbulb", Lightning: "Lightning", Link: "Link", Lock: "Lock", PaperPlane: "PaperPlaneTilt", Play: "Play", Search: "MagnifyingGlass", Settings: "Gear", Star: "Star", ThumbsUp: "ThumbsUp", Tool: "Hammer", Trust: "Handshake", Users: "Users", Verified: "SealCheck", Warning: "Warning", Wrench: "Wrench" };
const out = {};
for (const [name, phosphor] of Object.entries(map)) {
	const Icon = P[phosphor] ?? P[`${phosphor}Icon`];
	if (!Icon) {
		console.error("missing", phosphor);
		continue;
	}
	out[name] = renderToStaticMarkup(React.createElement(Icon, { size: "100%", weight: "regular", color: "currentColor" }));
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(Object.keys(out).length, "icons");
