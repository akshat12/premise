import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A live agent run (src/worker/agent/live.workers.test.ts) is configured from the shell. When
// LIVE_AGENT is set, these variables reach the test as bindings; otherwise none of them do.
// A provider key that is not in the shell is taken from .dev.vars, which the plugin loads itself.
const LIVE_VARS = ["LIVE_AGENT", "LIVE_MODEL", "LIVE_TASK", "LIVE_EFFORT", "LIVE_DEADLINE_S", "LIVE_FILES", "LIVE_HINT", "LIVE_LIBRARY", "LIVE_REDO", "LLM_BASE_URL", "LLM_MAX_TOKENS", "LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "CLOUDFLARE_API_TOKEN"];
const live: Record<string, string> = process.env.LIVE_AGENT ? Object.fromEntries(LIVE_VARS.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : []))) : {};

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
						miniflare: { bindings: { ...live, ADMIN_TOKEN: "test-admin-token", REPO_STORE: "memory", LLM: "scripted" } },
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
