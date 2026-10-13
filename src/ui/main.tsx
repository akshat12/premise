import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Two faces, self-hosted so the page works offline: Atkinson Hyperlegible Next for text and numerals, and
// its Mono for labels. They are drawn so that similar letters cannot be mistaken for one another, which is
// what small labels on a recorded screen need.
import "@fontsource/atkinson-hyperlegible-next/300.css";
import "@fontsource/atkinson-hyperlegible-next/400.css";
import "@fontsource/atkinson-hyperlegible-next/500.css";
import "@fontsource/atkinson-hyperlegible-next/600.css";
import "@fontsource/atkinson-hyperlegible-next/700.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/500.css";
import "@fontsource/atkinson-hyperlegible-mono/600.css";
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
