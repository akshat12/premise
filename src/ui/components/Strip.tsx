import { Tooltip } from "@cloudflare/kumo";
import { ArrowsClockwise, Bell, CheckCircle, Eye, HourglassMedium, LinkBreak, ListChecks, MagnifyingGlass, PencilSimple, ShieldCheck, Warning, XCircle } from "@phosphor-icons/react";
import type { IntentId, SymbolId } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { annotation, type Band, callsign, type Chip, chipsFor, STATUS_LOOK, type StatusIcon, symbolFile, symbolName } from "../lib/view";

const BAND: Record<Band, string> = { "ink-soft": "var(--ink-soft)", amber: "var(--amber)", redpen: "var(--redpen)", bluestamp: "var(--bluestamp)", holds: "var(--holds)" };

const ICONS: Record<StatusIcon, typeof Bell> = {
	plan: MagnifyingGlass,
	wait: HourglassMedium,
	work: PencilSimple,
	check: ListChecks,
	warn: Warning,
	gate: ShieldCheck,
	landed: CheckCircle,
	stale: LinkBreak,
	rederive: ArrowsClockwise,
	bell: Bell,
	failed: XCircle,
};

export function StatusMark({ status, size = 14 }: { status: IntentView["status"]; size?: number }) {
	const look = STATUS_LOOK[status];
	const Icon = ICONS[look.icon];
	return (
		<span className="inline-flex items-center gap-1" style={{ color: BAND[look.band], fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
			<Icon size={size} weight="bold" aria-hidden="true" />
			{look.word}
		</span>
	);
}

const SOURCE_WORDS = { observed: "You read this", derived: "Your code calls this", asserted: "You assert this behaviour", body: "Changes the body", interface: "Changes the interface" } as const;

function chipTip(chip: Chip) {
	return (
		<span style={{ display: "block", maxWidth: 360 }}>
			<span className="symbol" style={{ display: "block" }}>
				{symbolFile(chip.symbol)}#{symbolName(chip.symbol)}
			</span>
			<span style={{ display: "block" }}>{SOURCE_WORDS[chip.detail]}</span>
			{chip.description ? <span style={{ display: "block" }}>“{chip.description}”</span> : null}
			{chip.reason ? <span style={{ display: "block" }}>Broken: {chip.reason}</span> : null}
			{chip.hash ? (
				<span className="symbol" style={{ display: "block", opacity: 0.8 }}>
					surface {chip.hash.slice(0, 8)}
				</span>
			) : null}
		</span>
	);
}

/** A symbol the Intent changes (pencil) or relies on (eye). A broken one is struck through in red pen. */
export function SymbolChip({ chip, onHover }: { chip: Chip; onHover: (symbol: SymbolId | null) => void }) {
	const Icon = chip.kind === "changes" ? PencilSimple : Eye;
	const label = `${chip.kind === "changes" ? "changes" : "relies on"} ${symbolName(chip.symbol)}${chip.broken ? ", broken" : ""}`;
	return (
		<span className="chip-wrap" onMouseEnter={() => onHover(chip.symbol)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(chip.symbol)} onBlur={() => onHover(null)}>
		<Tooltip content={chipTip(chip)}>
			<span className="chip" data-broken={chip.broken} aria-label={label}>
				<Icon size={12} weight={chip.detail === "asserted" || chip.detail === "interface" ? "fill" : "regular"} aria-hidden="true" />
				<span className="symbol">{symbolName(chip.symbol)}</span>
				{chip.broken ? (
					<svg className="redpen-line" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
						<path d="M 2 13 C 22 8, 44 16, 62 10 S 90 9, 98 12" pathLength={100} />
					</svg>
				) : null}
			</span>
		</Tooltip>
		</span>
	);
}

interface StripProps {
	intent: IntentView;
	selected: boolean;
	dimmed: boolean;
	callsignOf: (id: IntentId) => string;
	onSelect: (id: IntentId) => void;
	onHoverSymbol: (symbol: SymbolId | null) => void;
}

const MAX_CHIPS = 3;

/** One Intent as a flight strip: holder band, callsign, what it changes and relies on, and any red-pen note. */
export function Strip({ intent, selected, dimmed, callsignOf, onSelect, onHoverSymbol }: StripProps) {
	const look = STATUS_LOOK[intent.status];
	const chips = chipsFor(intent);
	const note = annotation(intent, callsignOf);
	// With a red-pen note, the struck-through chip and the note are what matter: they go first and
	// the rest gives way. Otherwise what it changes leads, then what it relies on.
	const broken = chips.filter((chip) => chip.broken);
	const shown = note !== undefined && broken.length > 0 ? [broken[0] as Chip, ...chips.filter((chip) => chip.kind === "changes").slice(0, 1)] : chips.slice(0, MAX_CHIPS);
	const name = callsign(intent);
	return (
		<div className="strip" data-selected={selected} data-dimmed={dimmed} data-status={intent.status} style={{ ["--band" as string]: BAND[look.band] }}>
			<span className="strip-band" aria-hidden="true" />
			<button type="button" className="strip-open" onClick={() => onSelect(intent.id)} aria-pressed={selected} aria-label={`${name}, ${intent.goal.split(".")[0]}, ${look.word}${note ? `: ${note}` : ""}`}>
				<span className="flex items-center gap-2">
					<span className="callsign" style={{ fontSize: 20, lineHeight: 1, whiteSpace: "nowrap" }}>
						{name}
					</span>
					{(intent.races ?? 0) > 0 ? (
						<span className="stamp callsign" aria-label={`re-derive ${intent.races}`}>
							R{intent.races}
						</span>
					) : null}
				</span>
				<StatusMark status={intent.status} />
			</button>
			<div className="flex items-center gap-2 overflow-hidden" style={{ paddingRight: 10 }}>
				{shown.map((chip, index) => (
					<span key={`${chip.kind}:${chip.symbol}`} className="inline-flex items-center gap-2" style={{ minWidth: 0, flex: "none" }}>
						<SymbolChip chip={chip} onHover={onHoverSymbol} />
						{index === 0 && note && chip.broken ? <span className="annotation">{note}</span> : null}
					</span>
				))}
				{note && !(shown[0]?.broken ?? false) ? (
					<span className="annotation" style={{ color: "var(--amber)", flex: "none" }}>
						{note}
					</span>
				) : null}
				{chips.length > shown.length ? <span style={{ fontSize: 12, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>+{chips.length - shown.length}</span> : null}
			</div>
		</div>
	);
}
