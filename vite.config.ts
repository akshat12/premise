import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss(), cloudflare()],
	// The TypeScript compiler reads these Node globals when it loads inside the Worker (see T00).
	define: {
		__filename: JSON.stringify("/typescript.js"),
		__dirname: JSON.stringify("/"),
	},
});
