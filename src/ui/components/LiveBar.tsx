import { Button } from "@cloudflare/kumo";
import { Play } from "@phosphor-icons/react";
import type { LiveCaption, StartOffer } from "../lib/live";

interface LiveBarProps {
	caption: LiveCaption;
	offer: StartOffer;
	/** The stream from the Worker is open. When it is not, it is being retried. */
	connected: boolean;
	onStart: () => void;
}

/**
 * The Live tab's counterpart to the story bar: one sentence about what is happening on the board
 * right now, and the button that starts a run. It has the story bar's shape on purpose, so the two
 * tabs read as the same page, once recorded and once live.
 */
export function LiveBar({ caption, offer, connected, onStart }: LiveBarProps) {
	return (
		<section className="story live" aria-label="The live run">
			<div className="story-text">
				<div className="story-progress">
					{/* Whether this page is hearing from the Worker. "Live" means what is below is the board as it is this second. */}
					<span
						className="story-count live-flag"
						data-on={connected}
						role="status"
						title={connected ? "Connected to the Worker: what you see is its board as it is right now, and it updates by itself." : "Opening the connection to the Worker. If this stays for more than a few seconds, the Worker cannot be reached."}
					>
						{connected ? "Live" : "Connecting to the Worker…"}
					</span>
				</div>
				<div aria-live="polite">
					<h1 key={caption.id} className="story-title">
						{caption.title}
					</h1>
					{caption.body ? (
						<p key={`${caption.id}-body`} className="story-body">
							{caption.body}
						</p>
					) : null}
				</div>
			</div>
			<div className="story-controls live-controls">
				<Button variant="primary" size="lg" disabled={!offer.ready} onClick={onStart}>
					{offer.ready ? <Play size={16} weight="fill" aria-hidden="true" /> : null}
					{offer.label}
				</Button>
				{offer.note ? (
					<p className="live-note" role="status">
						{offer.note}
					</p>
				) : null}
			</div>
		</section>
	);
}
