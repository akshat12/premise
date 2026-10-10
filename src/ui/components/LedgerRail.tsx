import { CloudflareLogo } from "@cloudflare/kumo";
import { Eye, PencilSimple } from "@phosphor-icons/react";
import type { IntentId, SymbolId } from "../../shared/types";
import type { LedgerRow } from "../lib/view";
import { symbolName } from "../lib/view";

interface LedgerRailProps {
	rows: LedgerRow[];
	/** There are Intents on the board, so an empty ledger means they have all finished. */
	quiet: boolean;
	callsignOf: (id: IntentId) => string;
	hoverSymbol: SymbolId | null;
	onHoverSymbol: (symbol: SymbolId | null) => void;
	/** Take the whole width (the ledger as a view of its own, on narrow screens) instead of a 320px rail. */
	fill?: boolean;
}

/** The one place Cloudflare's mark appears. */
export function BuiltOn() {
	return (
		<div className="flex items-center gap-2" style={{ padding: "8px 16px", fontSize: 12, color: "var(--ink-soft)" }}>
			<CloudflareLogo variant="glyph" className="h-4 w-auto" />
			Built on Cloudflare Workers + Artifacts
		</div>
	);
}

const short = (callsign: string) => callsign.split(" ")[0] ?? callsign;

/** The ledger: for each symbol in play, who is changing it and who relies on it. */
export function LedgerRail({ rows, quiet, callsignOf, hoverSymbol, onHoverSymbol, fill = false }: LedgerRailProps) {
	return (
		<aside className="flex flex-col" style={fill ? { background: "#fff", border: "1px solid var(--rule)", borderRadius: 3 } : { width: 320, flex: "none", background: "#fff", borderLeft: "1px solid var(--rule)" }} aria-label="Ledger">
			<div style={{ padding: "12px 16px 8px", borderBottom: "1px solid var(--rule)" }}>
				<h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Ledger</h2>
				<p style={{ fontSize: 12, color: "var(--ink-soft)", margin: "2px 0 0" }}>Who changes each symbol, and who relies on it.</p>
			</div>
			<ul className={fill ? undefined : "flex-1 overflow-y-auto"} style={{ listStyle: "none", margin: 0, padding: 0 }}>
				{rows.length === 0 ? <li style={{ padding: 16, fontSize: 13, color: "var(--ink-soft)" }}>{quiet ? "Nothing in flight: every Intent has landed or stopped." : "Nothing is claimed or relied on yet."}</li> : null}
				{rows.map((row) => {
					const active = hoverSymbol === row.symbol;
					return (
						<li key={row.symbol}>
							<button
								type="button"
								onMouseEnter={() => onHoverSymbol(row.symbol)}
								onMouseLeave={() => onHoverSymbol(null)}
								onFocus={() => onHoverSymbol(row.symbol)}
								onBlur={() => onHoverSymbol(null)}
								aria-label={`${symbolName(row.symbol)}: ${row.writer ? `changed by ${callsignOf(row.writer)}` : "nobody is changing it"}, relied on by ${row.readers.length}${row.broken.length > 0 ? `, ${row.broken.length} broken` : ""}`}
								style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 16px", border: 0, borderBottom: "1px solid var(--rule)", background: active ? "var(--board)" : "#fff", cursor: "default", color: "var(--ink)" }}
							>
								<span className="flex items-baseline justify-between gap-2">
									<span className="symbol" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: row.broken.length > 0 ? "var(--redpen)" : "var(--ink)" }}>
										{symbolName(row.symbol)}
									</span>
									<span style={{ fontSize: 12, color: row.broken.length > 0 ? "var(--redpen)" : row.contested ? "var(--amber)" : "var(--ink-soft)", whiteSpace: "nowrap" }}>
										{row.broken.length > 0 ? "premise broken" : row.contested ? "contested" : ""}
									</span>
								</span>
								<span className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: 12, marginTop: 4 }}>
									{row.writer ? (
										<span className="inline-flex items-center gap-1 callsign" style={{ fontSize: 14 }}>
											<PencilSimple size={12} aria-hidden="true" />
											{short(callsignOf(row.writer))}
										</span>
									) : null}
									{row.readers.length > 0 ? (
										<span className="inline-flex items-center gap-1 callsign" style={{ fontSize: 14, color: "var(--ink-soft)" }}>
											<Eye size={12} aria-hidden="true" />
											{row.readers.map((id) => (
												<span key={id} style={row.broken.includes(id) ? { color: "var(--redpen)", textDecoration: "line-through" } : undefined}>
													{short(callsignOf(id))}
												</span>
											))}
										</span>
									) : null}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{fill ? null : (
				<div style={{ borderTop: "1px solid var(--rule)" }}>
					<BuiltOn />
				</div>
			)}
		</aside>
	);
}
