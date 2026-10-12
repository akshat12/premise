// The marks an Intent's state is drawn with: a band colour, a status icon and word, and how a stopped Intent was settled.
import { ArrowsClockwise, Bell, Check, CheckCircle, HourglassMedium, LinkBreak, ListChecks, MagnifyingGlass, PencilSimple, ShieldCheck, Warning, X, XCircle } from "@phosphor-icons/react";
import { type RaceMark, raceRows } from "../lib/chips";
import type { IntentView } from "../lib/reduce";
import { type Band, STATUS_LOOK, type StatusIcon } from "../lib/view";

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
		<span className="status-mark inline-flex items-center gap-1" title={look.means} style={{ color: BAND[look.band] }}>
			<Icon size={size} weight="bold" aria-hidden="true" />
			{look.word}
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
		<span className="flex flex-col justify-center" style={{ fontSize: 13, lineHeight: "15px", flex: "none", whiteSpace: "nowrap" }} role="img" title="A stopped Intent tries a plain rebase first. If that does not pass the gate, its agent redoes the work on the new trunk (a re-derive)." aria-label={`Rebase ${race.rebase}, re-derive ${race.rederive}${race.winner ? `: the ${race.winner === "rebase" ? "rebase" : "re-derive"} landed` : ""}`}>
			{row("rebase", "rebase")}
			{row("rederive", "re-derive")}
		</span>
	);
}
