import { Tooltip } from "@cloudflare/kumo";
import { ArrowsClockwise, Bell, Check, CheckCircle, Eye, Flag, HourglassMedium, LinkBreak, ListChecks, MagnifyingGlass, PencilSimple, ShieldCheck, Warning, X, XCircle } from "@phosphor-icons/react";
import { type RaceMark, raceRows } from "../lib/chips";
import type { IntentId, SymbolId } from "../../shared/types";
import type { IntentView } from "../lib/reduce";
import { annotation, type Band, callsign, type Chip, chipsFor, STATUS_LOOK, type StatusIcon, symbolFile, symbolName } from "../lib/view";

export const BAND: Record<Band, string> = { "ink-soft": "var(--ink-soft)", amber: "var(--amber)", redpen: "var(--redpen)", bluestamp: "var(--bluestamp)", holds: "var(--holds)" };

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
		<span className="inline-flex items-center gap-1" title={look.means} style={{ color: BAND[look.band], fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
			<Icon size={size} weight="bold" aria-hidden="true" />
			{look.word}
		</span>
	);
}

const SOURCE_WORDS = { observed: "The agent read this", derived: "Its code calls this", asserted: "The agent asserted this behaviour", body: "Changes the body", interface: "Changes the interface" } as const;

const same = (text: string) => text;

function chipTip(chip: Chip, named: (text: string) => string) {
	return (
		<span style={{ display: "block", maxWidth: 360 }}>
			<span className="symbol" style={{ display: "block" }}>
				{symbolFile(chip.symbol)}#{symbolName(chip.symbol)}
			</span>
			<span style={{ display: "block" }}>{SOURCE_WORDS[chip.detail]}</span>
			{chip.description ? <span style={{ display: "block" }}>“{chip.description}”</span> : null}
			{chip.reason ? <span style={{ display: "block" }}>Broken: {named(chip.reason)}</span> : null}
			{chip.hash ? (
				<span className="symbol" style={{ display: "block", opacity: 0.8 }}>
					surface {chip.hash.slice(0, 8)}
				</span>
			) : null}
		</span>
	);
}

/** A symbol the Intent changes (pencil) or relies on (eye). A broken one is struck through in red pen. */
export function SymbolChip({ chip, shared = false, onHover, named = same }: { chip: Chip; shared?: boolean; onHover: (symbol: SymbolId | null) => void; named?: (text: string) => string }) {
	// Pencil: it changes this. Eye: it relies on this. Flag: it relies on how this behaves, and asserted so.
	const Icon = chip.kind === "changes" ? PencilSimple : chip.detail === "asserted" ? Flag : Eye;
	const label = `${chip.kind === "changes" ? "changes" : "relies on"} ${symbolName(chip.symbol)}${chip.detail === "interface" ? ", its interface" : ""}${chip.detail === "asserted" ? ", asserted" : ""}${chip.broken ? ", broken" : ""}${shared ? ", shared with another Intent" : ""}`;
	const iconColor = chip.broken ? "var(--redpen)" : chip.kind === "relies" ? "var(--holds)" : "var(--ink)";
	return (
		<span className="chip-wrap" onMouseEnter={() => onHover(chip.symbol)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(chip.symbol)} onBlur={() => onHover(null)}>
		<Tooltip content={chipTip(chip, named)}>
			<span className="chip" data-broken={chip.broken} data-shared={shared} aria-label={label}>
				<Icon size={12} weight={chip.detail === "asserted" ? "fill" : "regular"} color={iconColor} aria-hidden="true" />
				<span className="symbol">{symbolName(chip.symbol)}</span>
				{chip.detail === "interface" ? <span style={{ fontSize: 10, color: "var(--ink-soft)" }}>if</span> : null}
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

const RACE_ICON: Record<RaceMark, typeof Bell> = { pending: HourglassMedium, pass: Check, fail: X };
const RACE_COLOR: Record<RaceMark, string> = { pending: "var(--ink-soft)", pass: "var(--holds)", fail: "var(--redpen)" };

/** How a stale Intent was settled, in two rows: the plain rebase is tried first, then the re-derive. The one that landed is in bold. */
export function RaceIndicator({ intent }: { intent: Pick<IntentView, "race"> }) {
	const race = raceRows(intent);
	if (race === null) {
		return null;
	}
	const row = (name: "rebase" | "rederive", label: string) => {
		const mark = race[name];
		const Icon = RACE_ICON[mark];
		return (
			<span className="flex items-center gap-1" style={{ color: RACE_COLOR[mark], fontWeight: race.winner === name ? 700 : 400 }}>
				<Icon size={12} weight="bold" aria-hidden="true" />
				{label}
			</span>
		);
	};
	return (
		<span className="flex flex-col justify-center" style={{ fontSize: 13, lineHeight: "15px", flex: "none", whiteSpace: "nowrap" }} role="img" title="A stale Intent tries a plain rebase first. If that does not pass the gate, its agent redoes the work on the new trunk (a re-derive)." aria-label={`Rebase ${race.rebase}, re-derive ${race.rederive}${race.winner ? `: the ${race.winner === "rebase" ? "rebase" : "re-derive"} landed` : ""}`}>
			{row("rebase", "rebase")}
			{row("rederive", "re-derive")}
		</span>
	);
}

interface StripProps {
	intent: IntentView;
	/** Symbols one Intent changes while another relies on them. */
	shared: ReadonlySet<SymbolId>;
	selected: boolean;
	dimmed: boolean;
	callsignOf: (id: IntentId) => string;
	onSelect: (id: IntentId) => void;
	onHoverSymbol: (symbol: SymbolId | null) => void;
	/** On a phone the strip is two lines: callsign and status, then the chips, which may wrap. */
	stacked?: boolean;
}

const MAX_CHIPS = 3;

/** One Intent as a flight strip: holder band, callsign, what it changes and relies on, and any red-pen note. */
export function Strip({ intent, shared, selected, dimmed, callsignOf, onSelect, onHoverSymbol, stacked = false }: StripProps) {
	// Messages from the backend name Intents by id. On screen they go by callsign.
	const named = (text: string) => text.replace(/\bi[0-9a-z]{8}\b/g, (id) => callsignOf(id)).replace(/\bintent (T\d+ )/g, "$1");
	const look = STATUS_LOOK[intent.status];
	const chips = chipsFor(intent);
	// The status word already says "re-deriving", and the race rows take room: keep the note to what changed.
	const note = annotation(intent, callsignOf)?.replace(intent.race ? /: re-deriving$/ : /$^/, "");
	// With a red-pen note, the struck-through chip and the note are what matter: they go first and
	// the rest gives way. Otherwise what it changes leads, then what it relies on.
	const broken = chips.filter((chip) => chip.broken);
	// A phone's strip has room for two chips on its second line, or for one chip and a note.
	const shown = note !== undefined && broken.length > 0 ? [broken[0] as Chip, ...(stacked ? [] : chips.filter((chip) => chip.kind === "changes").slice(0, 1))] : chips.slice(0, stacked ? (note === undefined ? 2 : 1) : MAX_CHIPS);
	const name = callsign(intent);
	return (
		<div className="strip" data-stacked={stacked} data-selected={selected} data-dimmed={dimmed} data-status={intent.status} style={{ ["--band" as string]: BAND[look.band] }}>
			<span className="strip-band" aria-hidden="true" />
			<button type="button" className="strip-open" onClick={() => onSelect(intent.id)} aria-pressed={selected} aria-label={`${name}, ${intent.goal.split(".")[0]}, ${look.word}${note ? `: ${note}` : ""}`}>
				<span className="flex items-center gap-2">
					<span className="callsign" style={{ fontSize: 13, lineHeight: 1, whiteSpace: "nowrap" }}>
						{name}
					</span>
					{(intent.races ?? 0) > 0 ? (
						<span className="stamp callsign" aria-label={`re-derive ${intent.races}`}>
							R{intent.races}
						</span>
					) : null}
				</span>
				<StatusMark status={intent.status} />
				{stacked && intent.race ? (
					<span style={{ marginLeft: "auto" }}>
						<RaceIndicator intent={intent} />
					</span>
				) : null}
			</button>
			<div className="strip-chips flex items-center gap-2 overflow-hidden" style={{ paddingRight: intent.race && !stacked ? 98 : 10 }}>
				{shown.map((chip, index) => (
					<span key={`${chip.kind}:${chip.symbol}`} className="chip-group inline-flex items-center gap-2" data-note={index === 0 && note !== undefined && chip.broken}>
						<SymbolChip chip={chip} shared={shared.has(chip.symbol)} onHover={onHoverSymbol} named={named} />
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
			{intent.race && !stacked ? (
				<div className="flex items-center" style={{ position: "absolute", right: 0, top: 0, bottom: 0, padding: "0 8px", background: "var(--strip)", borderLeft: "1px solid var(--rule)", borderRadius: "0 2px 2px 0" }}>
					<RaceIndicator intent={intent} />
				</div>
			) : null}
		</div>
	);
}
