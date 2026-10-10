import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `vite --mode offline` (npm run dev:local) uses a Worker config with no remote bindings, so it
// needs no Cloudflare login. Everything else uses wrangler.jsonc.
export default defineConfig(({ mode }) => ({
	plugins: [react(), tailwindcss(), cloudflare(mode === "offline" ? { configPath: "./wrangler.local.jsonc" } : {})],
	// The TypeScript compiler reads these Node globals when it loads inside the Worker (see T00).
	define: {
		__filename: JSON.stringify("/typescript.js"),
		__dirname: JSON.stringify("/"),
	},
}));
