// Test support: the demo repo and its reference solutions as data. Import this from tests only.
import { DEMO_REPO_FILES } from "../ports/demo-seed";
import { applyChanges } from "../ports/memory-repo-store";
import type { FileChanges, FileMap } from "../ports/repo-store";

const PATCHES = import.meta.glob<FileChanges>("/demo-repo/premise/reference/*.patch.ts", { import: "default", eager: true });

/** A fresh copy of the demo repo's files. */
export function demoFiles(): FileMap {
	return { ...DEMO_REPO_FILES };
}

/** A reference solution from demo-repo/premise/reference/, e.g. "t01" or "t02-rederived". */
export function referencePatch(id: string): FileChanges {
	const patch = PATCHES[`/demo-repo/premise/reference/${id}.patch.ts`];
	if (patch === undefined) {
		throw new Error(`no reference patch "${id}"`);
	}
	return patch;
}

/** The demo repo with the named reference solutions applied in order. */
export function demoWith(...patchIds: string[]): FileMap {
	return patchIds.reduce((files, id) => applyChanges(files, referencePatch(id)), demoFiles());
}
