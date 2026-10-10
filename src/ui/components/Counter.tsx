import { useEffect, useRef, useState } from "react";

/** A number that rolls from its old value to its new one over 300 ms. Tabular figures, so nothing jitters. */
export function RollingNumber({ value }: { value: number }) {
	const [shown, setShown] = useState(value);
	const from = useRef(value);

	useEffect(() => {
		const start = from.current;
		if (start === value) {
			return;
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			from.current = value;
			setShown(value);
			return;
		}
		const began = performance.now();
		let frame = 0;
		const tick = (now: number) => {
			const progress = Math.min(1, (now - began) / 300);
			const current = Math.round(start + (value - start) * progress);
			from.current = current;
			setShown(current);
			if (progress < 1) {
				frame = requestAnimationFrame(tick);
			}
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [value]);

	return <span style={{ fontVariantNumeric: "tabular-nums" }}>{shown}</span>;
}

/** One figure in the top bar. `hero` is for the two numbers the screen is about. */
export function Counter({ label, value, hero = false, alert = false, wrap = false }: { label: string; value: number; hero?: boolean; alert?: boolean; wrap?: boolean }) {
	return (
		<div className="flex flex-col justify-center leading-none" aria-label={`${label}: ${value}`}>
			<span className="callsign" style={{ fontSize: hero ? 32 : 20, lineHeight: 1, color: alert && value > 0 ? "var(--redpen)" : "var(--ink)" }}>
				<RollingNumber value={value} />
			</span>
			<span style={{ fontSize: 12, lineHeight: "14px", color: "var(--ink-soft)", marginTop: 2, whiteSpace: wrap ? "normal" : "nowrap" }}>{label}</span>
		</div>
	);
}
