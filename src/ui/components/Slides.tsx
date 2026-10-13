import { useEffect, useRef } from "react";

/** The deck, served as a page of its own (built from docs/video/deck by `npm run slides`). */
export const SLIDES_URL = "/slides/";

interface SlidesOverlayProps {
	onClose: () => void;
}

/**
 * The slides, opened over the page they were asked for from, so the board underneath is as it was
 * when they are closed. The deck is its own page in a frame: it takes the arrow keys while it is
 * open, and tells this page when its Close is pressed (or Esc).
 */
export function SlidesOverlay({ onClose }: SlidesOverlayProps) {
	const frame = useRef<HTMLIFrameElement | null>(null);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.origin === window.location.origin && event.source === frame.current?.contentWindow && (event.data as { type?: unknown } | null)?.type === "premise-slides-close") {
				onClose();
			}
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("message", onMessage);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("message", onMessage);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [onClose]);
	return (
		<div className="slides-layer" role="dialog" aria-modal="true" aria-label="How Premise works">
			<button type="button" className="slides-scrim" aria-label="Close the slides" onClick={onClose} />
			<iframe ref={frame} className="slides-frame" title="How Premise works: the slides" src={`${SLIDES_URL}?embed`} onLoad={() => frame.current?.focus()} />
		</div>
	);
}

interface SlidesCardProps {
	onOpen: () => void;
	onDismiss: () => void;
}

/** Shown once, on a first visit to the Demo tab: an offer of the slides, out of the way of the board. */
export function SlidesCard({ onOpen, onDismiss }: SlidesCardProps) {
	return (
		<aside className="slides-card" aria-label="New here?">
			<p className="label slides-card-kicker">New here?</p>
			<p className="slides-card-line">See how Premise works, in a short set of slides.</p>
			<div className="slides-card-actions">
				<button type="button" className="slides-card-open" onClick={onOpen}>
					Open the slides
				</button>
				<button type="button" className="slides-card-dismiss" onClick={onDismiss}>
					Dismiss
				</button>
			</div>
		</aside>
	);
}
