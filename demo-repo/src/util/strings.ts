export function isBlank(value: string): boolean {
	return value.trim().length === 0;
}

/** Lowercases and trims. Addresses are compared in this form. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** `Ada Lovelace!` becomes `ada-lovelace`. */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Cuts `value` to at most `max` characters, ending with an ellipsis when it was shortened. */
export function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
}

export function capitalize(value: string): string {
	return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

export function padLeft(value: string | number, width: number, fill = "0"): string {
	return String(value).padStart(width, fill);
}

/** Number of user-visible characters, counting an emoji or accented letter as one. */
export function visibleLength(value: string): number {
	return [...value].length;
}
