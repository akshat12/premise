import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("/Users/axat/Projects/premise/package.json");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const P = await import("/Users/axat/Projects/premise/node_modules/@phosphor-icons/react/dist/ssr/index.es.js").catch(async () => import("/Users/axat/Projects/premise/node_modules/@phosphor-icons/react/dist/index.es.js"));
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
