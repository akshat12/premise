import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Two faces, self-hosted so the page works offline: Geist for text and numerals, Geist Mono for labels.
import "@fontsource/geist-sans/300.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
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
