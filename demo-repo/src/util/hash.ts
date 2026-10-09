const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-16 code units of `text`. Not cryptographic. */
export function fnv1a32(text: string, seed: number = FNV_OFFSET): number {
	let hash = seed >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash;
}

export function toHex(value: number, width = 8): string {
	return (value >>> 0).toString(16).padStart(width, "0");
}

/** A 16-hex-character digest built from two differently seeded FNV-1a passes. */
export function hashString(text: string): string {
	return toHex(fnv1a32(text)) + toHex(fnv1a32(text, 0x9747b28c));
}

/** Order-sensitive combination of several digests into one. */
export function combineHashes(parts: readonly string[]): string {
	return hashString(parts.join("|"));
}

/** Digest of `text` mixed with `salt`, stretched over `rounds` passes. */
export function saltedHash(text: string, salt: string, rounds = 8): string {
	let digest = hashString(`${salt}:${text}`);
	for (let i = 1; i < rounds; i++) {
		digest = hashString(`${digest}:${salt}:${i}`);
	}
	return digest;
}

/** Compares two strings without stopping at the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}
