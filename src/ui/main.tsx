import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import "./theme.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("missing #root element");
}

createRoot(root).render(
	<StrictMode>
		<div className="isolate" style={{ height: "100%" }}>
			<App />
		</div>
	</StrictMode>,
);
