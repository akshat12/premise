// Shared by the scripts that drive a running Worker: command-line arguments and the admin token.
import { readFileSync } from "node:fs";

/** The value after `--name`, or `fallback` when it is not given. */
export function arg(name: string, fallback?: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : process.argv[index + 1];
}

/** True when `--name` is on the command line. */
export function flag(name: string): boolean {
	return process.argv.includes(`--${name}`);
}

/** True for a Worker running on this machine (`npm run dev`). */
function isLocal(url: string | undefined): boolean {
	try {
		return url !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * The admin token for the Worker at `url`: the ADMIN_TOKEN environment variable, or else the
 * token file that belongs to it. A local Worker uses .dev.vars; a deployed one uses .env.deployed
 * (and .dev.vars only if that is missing). It is never printed.
 */
export function adminToken(url?: string): string {
	if (process.env.ADMIN_TOKEN) {
		return process.env.ADMIN_TOKEN;
	}
	for (const file of isLocal(url) ? [".dev.vars"] : [".env.deployed", ".dev.vars"]) {
		try {
			const line = readFileSync(file, "utf8")
				.split("\n")
				.find((candidate) => candidate.startsWith("ADMIN_TOKEN="));
			const value = line
				?.slice("ADMIN_TOKEN=".length)
				.trim()
				.replace(/^["']|["']$/g, "");
			if (value) {
				return value;
			}
		} catch {
			// no such file: try the next
		}
	}
	throw new Error("Set ADMIN_TOKEN, or put it in .env.deployed (deployed Worker) or .dev.vars (local)");
}

/** A client for one Worker: JSON in, JSON out, with the admin token on every POST. */
export function worker(url: string) {
	const base = url.replace(/\/$/, "");
	const headers = { "x-admin-token": adminToken(url), "content-type": "application/json" };
	const read = async <T>(path: string, response: Response): Promise<T> => {
		if (!response.ok) {
			throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
		}
		return (await response.json()) as T;
	};
	return {
		base,
		get: async <T>(path: string): Promise<T> => read<T>(path, await fetch(`${base}${path}`)),
		post: async <T>(path: string, body: unknown = {}): Promise<T> => read<T>(path, await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })),
	};
}
