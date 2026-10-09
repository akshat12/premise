// Adapter that makes the docs' MemoryFS (memory-fs.ts, copied verbatim) usable with
// isomorphic-git 1.43.x, which needs two things the helper does not provide:
//   1. `readlink` and `symlink` on `fs.promises` (bindFs calls `.bind` on both).
//   2. Node-style `err.code` ("ENOENT", "ENOTDIR", ...). The helper only puts the
//      code in the message, so `exists()` and the recursive mkdir both blow up.
import { MemoryFS } from "./memory-fs";

type FsError = Error & { code?: string };

function withCode(error: unknown): unknown {
	if (error instanceof Error && (error as FsError).code === undefined) {
		const match = /^(E[A-Z]+):/.exec(error.message);
		if (match) {
			(error as FsError).code = match[1];
		}
	}
	return error;
}

function fsError(code: string, path: string): FsError {
	const error: FsError = new Error(`${code}: ${path}`);
	error.code = code;
	return error;
}

// Wraps an async fs method so that anything it throws carries `err.code`.
function coded<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
	return async (...args: A): Promise<R> => {
		try {
			return await fn(...args);
		} catch (error) {
			throw withCode(error);
		}
	};
}

export function createGitFs() {
	const memory = new MemoryFS();
	const p = memory.promises;
	return {
		promises: {
			readFile: coded(p.readFile),
			writeFile: coded(p.writeFile),
			unlink: coded(p.unlink),
			readdir: coded(p.readdir),
			// isomorphic-git expects a single-level mkdir that reports EEXIST / ENOENT.
			mkdir: coded(async (path: string) => {
				if (memory.getEntry(path)) {
					throw fsError("EEXIST", path);
				}
				await p.mkdir(path);
			}),
			rmdir: coded(p.rmdir),
			stat: coded(p.stat),
			lstat: coded(p.lstat),
			// The in-memory tree has no symlinks.
			readlink: async (path: string): Promise<string> => {
				throw fsError(memory.getEntry(path) ? "EINVAL" : "ENOENT", path);
			},
			symlink: async (_target: string, path: string): Promise<void> => {
				throw fsError("ENOTSUP", path);
			},
		},
	};
}
