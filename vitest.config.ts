import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				// Pure logic. Runs in Node, no Cloudflare runtime.
				test: {
					name: "unit",
					environment: "node",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.workers.test.ts"],
				},
			},
			{
				// Durable Objects, Workflows and the Worker Loader. Runs inside workerd.
				plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
				define: {
					__filename: JSON.stringify("/typescript.js"),
					__dirname: JSON.stringify("/"),
				},
				test: {
					name: "workers",
					include: ["src/**/*.workers.test.ts"],
				},
			},
		],
	},
});
