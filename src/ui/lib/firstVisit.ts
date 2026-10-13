/** Where the browser remembers that the "new here?" card has been shown. */
export const SLIDES_CARD_KEY = "premise.slides-card-shown";

type Memory = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether this is the visitor's first time on the plain Demo page, which is when the card that
 * offers the slides is shown. A link to something in particular (`?run=3`, `?live`, `?frame=…`)
 * never shows it: whoever opened that came for that. With no storage to remember in (a private
 * window that refuses it), the card stays away, since it could not be kept to one showing.
 */
export function isFirstVisit(memory: Memory | null, search: string): boolean {
	if (memory === null || new URLSearchParams(search).size > 0) {
		return false;
	}
	try {
		return memory.getItem(SLIDES_CARD_KEY) === null;
	} catch {
		return false;
	}
}

/** Records that the card has been shown, so it is not shown again. False when it could not be recorded. */
export function rememberVisit(memory: Memory | null): boolean {
	try {
		memory?.setItem(SLIDES_CARD_KEY, "1");
		return memory !== null;
	} catch {
		return false;
	}
}

/** The browser's storage, or null where reading it is refused. */
export function browserMemory(): Memory | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}
