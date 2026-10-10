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
					sequence: { groupOrder: 0 },
				},
			},
			{
				// Durable Objects, Workflows and the Worker Loader. Runs inside workerd.
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.test.jsonc" },
						// Fixed values, so the tests do not depend on what a developer has in .dev.vars.
						miniflare: { bindings: { ADMIN_TOKEN: "test-admin-token", REPO_STORE: "memory", LLM: "scripted" } },
					}),
				],
				define: {
					__filename: JSON.stringify("/typescript.js"),
					__dirname: JSON.stringify("/"),
				},
				test: {
					name: "workers",
					include: ["src/**/*.workers.test.ts"],
					// WebSockets to Durable Objects do not work with per-file storage isolation
					// (a documented limit of the vitest plugin), so run these files in one shared worker.
					maxWorkers: 1,
					isolate: false,
					// Projects with different maxWorkers must be in different groups.
					sequence: { groupOrder: 1 },
					// Pre-bundle the TypeScript compiler for workerd. Loaded unbundled it crashes the runtime.
					deps: { optimizer: { ssr: { enabled: true, include: ["typescript"] } } },
				},
			},
		],
	},
});
