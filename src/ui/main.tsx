import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/500.css";
// The tape view's own faces.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
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
