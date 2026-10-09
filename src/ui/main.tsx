import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("missing #root element");
}

createRoot(root).render(
	<StrictMode>
		<div className="isolate">
			<App />
		</div>
	</StrictMode>,
);
