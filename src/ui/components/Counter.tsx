import { useEffect, useRef, useState } from "react";

/** Changes bigger than this are not rolled through. */
const ROLL_LIMIT = 5;

/** A number that rolls from its old value to its new one over 300 ms. Tabular figures, so nothing jitters. */
export function RollingNumber({ value }: { value: number }) {
	const [shown, setShown] = useState(value);
	const from = useRef(value);

	useEffect(() => {
		const start = from.current;
		if (start === value) {
			return;
		}
		// A jump (a seek, a backlog arriving) is shown at once: rolling through it would show numbers that never were.
		if (Math.abs(value - start) > ROLL_LIMIT || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			from.current = value;
			setShown(value);
			return;
		}
		const began = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			// A frame's timestamp can be a hair earlier than `began`, so the progress is kept between 0 and 1:
			// otherwise the first frame overshoots backwards and a counter can flash a negative number.
			const progress = Math.max(0, Math.min(1, (now - began) / 300));
			const current = Math.round(start + (value - start) * progress);
			from.current = current;
			setShown(current);
			if (progress < 1) {
				frame = requestAnimationFrame(tick);
			}
		};
		frame = requestAnimationFrame(tick);
		// Frames are not guaranteed (a hidden or throttled tab gets none): the number is right by the end regardless.
		const settle = setTimeout(() => {
			from.current = value;
			setShown(value);
		}, 400);
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(settle);
		};
	}, [value]);

	return <span style={{ fontVariantNumeric: "tabular-nums" }}>{shown}</span>;
}

/** One figure in the top bar. `hero` is for the two numbers the screen is about. */
export function Counter({ label, value, hero = false, alert = false, wrap = false }: { label: string; value: number; hero?: boolean; alert?: boolean; wrap?: boolean }) {
	return (
		<div className="flex flex-col justify-center leading-none" aria-label={`${label}: ${value}`}>
			<span className="figure" style={{ fontSize: hero ? 32 : 22, lineHeight: 1, color: alert && value > 0 ? "var(--redpen)" : "var(--ink)" }}>
				<RollingNumber value={value} />
			</span>
			<span className="label" style={{ fontSize: 11, marginTop: 3, whiteSpace: wrap ? "normal" : "nowrap" }}>{label}</span>
		</div>
	);
}
