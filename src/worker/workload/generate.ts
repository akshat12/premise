// Scripted workload: edits a generator makes instead of a model. Each one is a real, small change
// to the repo that typechecks, so hundreds of them can go through the same pipeline as the agents'
// work (fork, claims, premises, push, checker, gate) at almost no cost. Pure and seeded: the same
// seed always gives the same edits.
import { parseSymbolId, symbolId } from "../../shared/ids";
import type { Claim, SymbolId } from "../../shared/types";
import type { FileChanges, FileMap } from "../ports/repo-store";
import { indexFile, type SymbolInfo } from "../symbols";

/**
 * What one edit does, as plain data, so it can be handed to another process and applied there.
 * `i` is its place in the run; `tag` (seed and place, e.g. "7_12") goes into the names it adds,
 * so two runs with different seeds never add the same name.
 */
export type EditSpec =
	/** A new file exporting one helper that calls one or two existing functions. */
	| { kind: "helper"; i: number; tag: string; path: string; name: string; uses: { symbol: SymbolId; alias: string }[] }
	/** Two lines added inside an existing function's body that change nothing it does. */
	| { kind: "body"; i: number; tag: string; symbol: SymbolId; overlaps?: number }
	/** An optional field added to an existing interface. This changes its type surface. */
	| { kind: "field"; i: number; tag: string; symbol: SymbolId };

export interface WorkloadEdit {
	spec: EditSpec;
	/** Symbols the edit relies on (recorded as observed premises). */
	reads: SymbolId[];
	claims: Claim[];
	/** The edit applied to a set of files. Throws if what it targets is no longer there. */
	changes: (files: FileMap) => FileChanges;
	label: string;
}

export const GENERATED_DIR = "src/generated/";

/** A small seeded random number generator (mulberry32). Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)] as T;

/**
 * Hands out the items in a random order, each once, before any is handed out a second time. So
 * two ordinary edits only go for the same target once every target has been used; contention
 * comes from the edits that overlap on purpose, at the rate asked for.
 */
function dealer<T>(items: readonly T[], random: () => number): () => T {
	let hand: T[] = [];
	return () => {
		if (hand.length === 0) {
			hand = [...items];
			for (let i = hand.length - 1; i > 0; i--) {
				const j = Math.floor(random() * (i + 1));
				[hand[i], hand[j]] = [hand[j] as T, hand[i] as T];
			}
		}
		return hand.pop() as T;
	};
}

/** The import specifier for `to` as seen from the file `from` (both repo-relative .ts paths). */
export function importSpecifier(from: string, to: string): string {
	const fromDir = from.split("/").slice(0, -1);
	const target = to.replace(/\.ts$/, ".js").split("/");
	let shared = 0;
	while (shared < fromDir.length && shared < target.length - 1 && fromDir[shared] === target[shared]) {
		shared++;
	}
	const up = fromDir.length - shared;
	return `${up === 0 ? "./" : "../".repeat(up)}${target.slice(shared).join("/")}`;
}

const lines = (text: string) => text.split("\n");
const indentOf = (line: string | undefined) => /^\s*/.exec(line ?? "")?.[0] ?? "";

/** Functions whose body is a block that spans lines, so a line can be added just inside it. */
export function bodyTargets(index: ReadonlyMap<SymbolId, SymbolInfo>): SymbolInfo[] {
	return [...index.values()].filter((info) => (info.kind === "function" || info.kind === "const") && info.signatureEndLine < info.endLine && !info.id.startsWith(GENERATED_DIR)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Interfaces an optional field can be added to without breaking anything. An interface whose keys
 * are enumerated somewhere (`keyof X`, `Required<X>`) is left out, because a new key would have
 * to be handled there.
 */
export function fieldTargets(index: ReadonlyMap<SymbolId, SymbolInfo>, files: FileMap): SymbolInfo[] {
	const everything = Object.values(files).join("\n");
	return [...index.values()]
		.filter((info) => {
			if (info.kind !== "interface" || info.id.startsWith(GENERATED_DIR) || info.endLine <= info.startLine) {
				return false;
			}
			const { path, name } = parseSymbolId(info.id);
			const closing = lines(files[path] ?? "")[info.endLine - 1] ?? "";
			return closing.trim().startsWith("}") && !new RegExp(`\\b(keyof\\s+${name}|Required<\\s*${name}|Readonly<\\s*${name})\\b`).test(everything);
		})
		.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Exported functions a generated helper can wrap. */
export function helperTargets(index: ReadonlyMap<SymbolId, SymbolInfo>): SymbolInfo[] {
	return [...index.values()].filter((info) => info.kind === "function" && !info.id.startsWith(GENERATED_DIR)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

function find(files: FileMap, symbol: SymbolId): { path: string; text: string; info: SymbolInfo } {
	const { path } = parseSymbolId(symbol);
	const text = files[path];
	const info = text === undefined ? undefined : indexFile(path, text).find((candidate) => candidate.id === symbol);
	if (text === undefined || info === undefined) {
		throw new Error(`${symbol} is no longer there`);
	}
	return { path, text, info };
}

/** Applies an edit to files. Only the files named by `editPaths` are read. */
export function applyEdit(spec: EditSpec, files: FileMap): FileChanges {
	switch (spec.kind) {
		case "helper": {
			const imports = spec.uses.map((use) => `import { ${parseSymbolId(use.symbol).name} as ${use.alias} } from "${importSpecifier(spec.path, parseSymbolId(use.symbol).path)}";`);
			const params = spec.uses.map((use, n) => `args${n}: Parameters<typeof ${use.alias}>`).join(", ");
			const returns = spec.uses.map((use) => `ReturnType<typeof ${use.alias}>`).join(", ");
			const calls = spec.uses.map((use, n) => `${use.alias}(...args${n})`).join(", ");
			const body = [
				...imports,
				"",
				`/** Workload helper ${spec.tag}: calls ${spec.uses.map((use) => parseSymbolId(use.symbol).name).join(" and ")}. Generated; not written by a model. */`,
				`export function ${spec.name}(${params}): [${returns}] {`,
				`\treturn [${calls}];`,
				"}",
				"",
			];
			return { [spec.path]: body.join("\n") };
		}
		case "body": {
			const { path, text, info } = find(files, spec.symbol);
			if (info.signatureEndLine >= info.endLine) {
				throw new Error(`${spec.symbol} no longer has a body that spans lines`);
			}
			const all = lines(text);
			const indent = indentOf(all[info.signatureEndLine]) || `${indentOf(all[info.signatureEndLine - 1])}\t`;
			all.splice(info.signatureEndLine, 0, `${indent}// workload w${spec.tag}: no behaviour change`, `${indent}const _w${spec.tag} = 0;`);
			return { [path]: all.join("\n") };
		}
		case "field": {
			const { path, text, info } = find(files, spec.symbol);
			if (info.kind !== "interface") {
				throw new Error(`${spec.symbol} is no longer an interface`);
			}
			const all = lines(text);
			const indent = indentOf(all[info.endLine - 2]) || `${indentOf(all[info.endLine - 1])}\t`;
			all.splice(info.endLine - 1, 0, `${indent}/** Added by workload w${spec.tag}. */`, `${indent}_w${spec.tag}?: number;`);
			return { [path]: all.join("\n") };
		}
	}
}

/** The existing files an edit reads when it is applied. */
export function editPaths(spec: EditSpec): string[] {
	return spec.kind === "helper" ? [] : [parseSymbolId(spec.symbol).path];
}

function toEdit(spec: EditSpec): WorkloadEdit {
	const changes = (files: FileMap) => applyEdit(spec, files);
	switch (spec.kind) {
		case "helper":
			return { spec, reads: spec.uses.map((use) => use.symbol), claims: [{ symbol: symbolId(spec.path, spec.name), mode: "interface" }], changes, label: `w${spec.tag}: wrap ${spec.uses.map((use) => parseSymbolId(use.symbol).name).join(", ")}` };
		case "body":
			return { spec, reads: [], claims: [{ symbol: spec.symbol, mode: "body" }], changes, label: `w${spec.tag}: touch the body of ${parseSymbolId(spec.symbol).name}${spec.overlaps === undefined ? "" : ` (same function as w${spec.tag.split("_")[0]}_${spec.overlaps})`}` };
		case "field":
			return { spec, reads: [], claims: [{ symbol: spec.symbol, mode: "interface" }], changes, label: `w${spec.tag}: add a field to ${parseSymbolId(spec.symbol).name}` };
	}
}

// Relative weights of the three ordinary kinds. The fourth kind, an edit to a function another
// edit also touches, is chosen with probability `overlapRate` instead.
const WEIGHTS = { helper: 50, body: 30, field: 15 } as const;

/**
 * `n` edits against a repo. About half add a helper file, a third touch a function body, and the
 * rest add an interface field, which changes a type surface and so invalidates whoever reads it.
 * With probability `overlapRate` an edit goes for a function an earlier edit already touches,
 * which makes the two contend for the same claim in the ledger.
 */
export function generateEdits(index: ReadonlyMap<SymbolId, SymbolInfo>, files: FileMap, n: number, seed: number, overlapRate: number): WorkloadEdit[] {
	const random = mulberry32(seed);
	const helpers = helperTargets(index);
	const bodies = bodyTargets(index);
	const fields = fieldTargets(index, files);
	const nextBody = dealer(bodies, random);
	const nextField = dealer(fields, random);
	const edits: WorkloadEdit[] = [];
	const touched: { i: number; symbol: SymbolId }[] = [];
	const total = WEIGHTS.helper + WEIGHTS.body + WEIGHTS.field;

	for (let i = 0; i < n; i++) {
		const tag = `${Math.abs(Math.trunc(seed))}_${i}`;
		let spec: EditSpec | undefined;
		if (touched.length > 0 && random() < overlapRate) {
			const earlier = pick(touched, random);
			spec = { kind: "body", i, tag, symbol: earlier.symbol, overlaps: earlier.i };
		} else {
			const roll = random() * total;
			const kind = roll < WEIGHTS.helper ? "helper" : roll < WEIGHTS.helper + WEIGHTS.body ? "body" : "field";
			if (kind === "body" && bodies.length > 0) {
				spec = { kind, i, tag, symbol: nextBody().id };
				touched.push({ i, symbol: spec.symbol });
			} else if (kind === "field" && fields.length > 0) {
				spec = { kind, i, tag, symbol: nextField().id };
			} else if (helpers.length > 0) {
				const first = pick(helpers, random);
				const second = random() < 0.5 ? pick(helpers, random) : first;
				const uses = (second.id === first.id ? [first] : [first, second]).map((info, n2) => ({ symbol: info.id, alias: `f${n2}` }));
				spec = { kind: "helper", i, tag, path: `${GENERATED_DIR}w${tag}.ts`, name: `w${tag}`, uses };
			}
		}
		if (spec !== undefined) {
			edits.push(toEdit(spec));
		}
	}
	return edits;
}
