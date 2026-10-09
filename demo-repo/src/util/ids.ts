/** Produces a new unique id each time it is called. */
export type IdGenerator = () => string;

export const ID_PREFIXES = {
	user: "usr",
	session: "ses",
	invoice: "inv",
	invite: "ivt",
	ledgerEntry: "led",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** `usr_000001`, `usr_000002`, ... Deterministic, for tests and seeding. */
export function sequentialIds(kind: IdKind, start = 1): IdGenerator {
	let next = start;
	return () => prefixedId(kind, next++);
}

export function prefixedId(kind: IdKind, sequence: number): string {
	return `${ID_PREFIXES[kind]}_${String(sequence).padStart(6, "0")}`;
}

export function isPrefixedId(value: string, kind: IdKind): boolean {
	return new RegExp(`^${ID_PREFIXES[kind]}_[0-9]{6,}$`).test(value);
}

/** Splits `usr_000042` into its kind and sequence number. Returns null if it is not one of our ids. */
export function parsePrefixedId(value: string): { kind: IdKind; sequence: number } | null {
	const [prefix, digits] = value.split("_");
	const kind = (Object.keys(ID_PREFIXES) as IdKind[]).find((key) => ID_PREFIXES[key] === prefix);
	if (kind === undefined || digits === undefined || !/^[0-9]+$/.test(digits)) {
		return null;
	}
	return { kind, sequence: Number(digits) };
}

/** A repeatable pseudo-random id source (linear congruential), seeded so runs are reproducible. */
export function seededIds(kind: IdKind, seed: number): IdGenerator {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return `${ID_PREFIXES[kind]}_${state.toString(36).padStart(7, "0")}`;
	};
}
