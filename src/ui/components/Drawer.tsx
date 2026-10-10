import { Button } from "@cloudflare/kumo";
import type { IntentView } from "../lib/reduce";
import { callsign } from "../lib/view";
import { StatusMark } from "./Strip";

/** The selected Intent, in brief. T21 replaces this with the full premise list and gate report. */
export function Drawer({ intent, onClose }: { intent: IntentView; onClose: () => void }) {
	const broken = intent.premises.filter((premise) => premise.state === "broken");
	return (
		<section className="drawer" style={{ height: 280, flex: "none", padding: "16px 24px", overflowY: "auto" }} aria-label={`${callsign(intent)} details`}>
			<div className="flex items-start justify-between gap-4">
				<div>
					<div className="flex items-center gap-3">
						<span className="callsign" style={{ fontSize: 20 }}>
							{callsign(intent)}
						</span>
						<StatusMark status={intent.status} />
					</div>
					<p style={{ fontSize: 14, margin: "8px 0 0", maxWidth: 760 }}>{intent.goal}</p>
				</div>
				<Button variant="ghost" size="sm" onClick={onClose}>
					Close
				</Button>
			</div>
			{intent.why.length > 0 ? (
				<ul style={{ fontSize: 13, margin: "12px 0 0", paddingLeft: 18, color: "var(--ink-soft)", maxWidth: 760 }}>
					{intent.why.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			) : null}
			<p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "12px 0 0" }}>
				Changes {intent.claims.length} symbol{intent.claims.length === 1 ? "" : "s"}; relies on {intent.premises.length}
				{broken.length > 0 ? `, ${broken.length} broken` : ""}.
			</p>
			{intent.lastNote ? <p style={{ fontSize: 13, margin: "8px 0 0", color: broken.length > 0 ? "var(--redpen)" : "var(--ink)" }}>{intent.lastNote}</p> : null}
		</section>
	);
}
