export function groupBy<T, K extends string | number>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
	const groups = new Map<K, T[]>();
	for (const item of items) {
		const group = groups.get(key(item));
		if (group) {
			group.push(item);
		} else {
			groups.set(key(item), [item]);
		}
	}
	return groups;
}

export function indexBy<T, K extends string | number>(items: readonly T[], key: (item: T) => K): Map<K, T> {
	return new Map(items.map((item) => [key(item), item]));
}

export function sumBy<T>(items: readonly T[], amount: (item: T) => number): number {
	return items.reduce((total, item) => total + amount(item), 0);
}

/** Keeps the first item for each key. */
export function uniqueBy<T, K>(items: readonly T[], key: (item: T) => K): T[] {
	const seen = new Set<K>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) {
			return false;
		}
		seen.add(k);
		return true;
	});
}

export function sortBy<T>(items: readonly T[], key: (item: T) => number | string): T[] {
	return [...items].sort((a, b) => {
		const ka = key(a);
		const kb = key(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (size <= 0) {
		throw new Error("chunk size must be positive");
	}
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}
