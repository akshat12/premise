import { useEffect, useState } from "react";

/** How long the details panel takes to slide away (theme.css, `drawer-out`). */
export const DRAWER_OUT_MS = 170;
/** How long a past run's side panel takes to slide in (theme.css, `.past-run`). */
export const PANEL_IN_MS = 280;
/** How long a past run's side panel takes to slide away (theme.css, `past-run-out`). */
export const PANEL_OUT_MS = 190;

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * What a panel should show while it slides out: the last value it had, for `exitMs` after the value
 * goes away, with `leaving` set so its stylesheet can play the exit. A new value cancels the exit at
 * once. With reduced motion there is no exit to wait for.
 */
export function usePresence<T>(value: T | null | undefined, exitMs: number): { shown: T | null; leaving: boolean } {
	const present = value ?? null;
	const [kept, setKept] = useState<T | null>(present);
	useEffect(() => {
		if (present !== null) {
			setKept(present);
			return;
		}
		const timer = setTimeout(() => setKept(null), reducedMotion() ? 0 : exitMs);
		return () => clearTimeout(timer);
	}, [present, exitMs]);
	return present !== null ? { shown: present, leaving: false } : { shown: kept, leaving: kept !== null };
}

/**
 * False on a panel's first frame and true from the next, so a transition has a starting point to
 * run from: it is drawn off-screen, then moved on. (Two frames, so the first is really painted.)
 */
export function useEntered(): boolean {
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => setEntered(true));
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, []);
	return entered;
}
