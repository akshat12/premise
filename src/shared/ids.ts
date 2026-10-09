import type { IntentId, SymbolId } from "./types";

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_REPO_NAME_LENGTH = 63;

/** A fresh Intent id: "i" + 8 lowercase base36 chars. Also a valid Artifacts repo name. */
export function newIntentId(): IntentId {
	// 252 is the largest multiple of 36 that fits in a byte; rejecting bytes above it avoids modulo bias.
	const chars: string[] = [];
	while (chars.length < 8) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			if (byte < 252 && chars.length < 8) {
				chars.push(BASE36.charAt(byte % 36));
			}
		}
	}
	return `i${chars.join("")}`;
}

/** Builds "<repo-relative path>#<exportName>". */
export function symbolId(path: string, exportName: string): SymbolId {
	if (path === "" || exportName === "" || path.includes("#") || exportName.includes("#")) {
		throw new Error(`cannot build a SymbolId from path "${path}" and export "${exportName}"`);
	}
	return `${path}#${exportName}`;
}

/** Splits a SymbolId into its path and export name. Throws on malformed input. */
export function parseSymbolId(id: SymbolId): { path: string; name: string } {
	const parts = id.split("#");
	const [path, name] = parts;
	if (parts.length !== 2 || !path || !name) {
		throw new Error(`malformed SymbolId: "${id}"`);
	}
	return { path, name };
}

/**
 * The LedgerShard that owns a symbol: the first two path segments of its file's directory.
 * "src/auth/session.ts#x" -> "src/auth"; a file directly under "src/" -> "src".
 */
export function moduleShard(symbol: SymbolId): string {
	const { path } = parseSymbolId(symbol);
	const dirs = path.split("/").slice(0, -1);
	return dirs.length === 0 ? "." : dirs.slice(0, 2).join("/");
}

/** Artifacts repo name rule: starts with a letter or digit, then [A-Za-z0-9._-], at most 63 chars. */
export function isValidRepoName(name: string): boolean {
	return name.length <= MAX_REPO_NAME_LENGTH && REPO_NAME.test(name);
}
