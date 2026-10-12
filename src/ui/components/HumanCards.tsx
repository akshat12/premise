import { Button } from "@cloudflare/kumo";
import { Bell } from "@phosphor-icons/react";
import { useState } from "react";
import type { IntentId } from "../../shared/types";
import { answerCard, explain } from "../lib/api";
import type { IntentView } from "../lib/reduce";
import { callsign, symbolName, waitingOn } from "../lib/view";

type Choice = "Wait" | "Split" | "Depend" | "Retry" | "Abandon";

/** What each button does, in one line. The button's name is the action's exact name. */
const EXPLAIN: Record<Choice, string> = {
	Wait: "Hold this Intent until the other one lands, then ask again.",
	Split: "Give the contested symbol to this Intent now. The other keeps the rest.",
	Depend: "Let this Intent build on the other's work. It waits, and is told when that lands.",
	Retry: "Re-derive once more on trunk as it is now.",
	Abandon: "Stop this Intent and release everything it holds.",
};

/** The symbols two Intents both want, by name. */
function contested(intent: IntentView): string[] {
	const decision = intent.decision;
	const symbols = intent.outOfClaim && intent.outOfClaim.length > 0 ? intent.outOfClaim : decision?.kind === "split" ? [...decision.proposal.mine, ...decision.proposal.theirs] : decision && decision.kind !== "granted" ? decision.symbols : [];
	return [...new Set(symbols.map(symbolName))];
}

/** A goal short enough for a card: its first sentence, without the code ticks. */
function brief(goal: string): string {
	return `${(goal.split(". ")[0] ?? goal).replace(/`/g, "").replace(/\.$/, "")}.`;
}

/** Two lines at most; the strip and the drawer have the whole goal. */
const GOAL_LINE = { margin: "6px 0 0", fontSize: 13, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

/** The last gate errors, at most three lines. */
function gateErrors(intent: IntentView): string[] {
	const report = intent.gate;
	if (report === undefined) {
		return [];
	}
	const lines = report.textConflict
		? ["The rebase hit a text conflict."]
		: !report.typecheck.ok
			? report.typecheck.errors
			: [...report.assertions.failed.map((failure) => `Premise ${failure.id}: ${failure.error}`), ...report.tests.failed.map((failure) => `"${failure.name}": ${failure.error}`)];
	return lines.slice(0, 3);
}

interface CardProps {
	/** In the page's flow on a narrow screen: full width, and no room for what a button that is off would do. */
	inline: boolean;
	intent: IntentView;
	other?: IntentView;
	/** In a replay nothing can be answered: the recording decides. */
	readOnly: boolean;
	token: string;
	named: (text: string) => string;
	onNeedToken: () => void;
	nameOf?: (id: IntentId) => string;
}

function HumanCard({ inline, intent, other, readOnly, token, named, nameOf, onNeedToken }: CardProps) {
	const shortName = (subject: IntentView) => nameOf?.(subject.id) ?? callsign(subject).split(" ")[0];
	const [applied, setApplied] = useState<Choice | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const human = intent.human;
	if (human === undefined) {
		return null;
	}
	const stalemate = human.kind === "stalemate";
	const symbols = contested(intent);
	const title = stalemate ? `Two Intents both want ${symbols.length > 0 ? symbols.slice(0, 2).join(" and ") : "the same symbol"}` : "Re-derive failed twice";
	const errors = stalemate ? [] : gateErrors(intent);

	async function choose(choice: Choice) {
		if (token === "") {
			onNeedToken();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await answerCard(intent.id, choice, token);
			setApplied(choice); // the card closes when the answer comes back through the event stream
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	// In a recording nobody can answer, and a claim two Intents both want is the ledger's everyday case, not the
	// event the run is about. One amber line says it; the full card is for a live run, where there are buttons to press.
	if (readOnly && stalemate) {
		return (
			<p className="flex items-center gap-2" role="note" style={{ width: inline ? "100%" : 360, maxWidth: inline ? 480 : "100%", margin: 0, background: "#fff", border: "1px solid var(--rule)", borderLeft: "4px solid var(--amber)", borderRadius: 3, padding: "6px 10px", fontSize: 13 }}>
				<Bell size={14} weight="fill" color="var(--amber)" aria-hidden="true" style={{ flex: "none" }} />
				<span>
					<span className="callsign" style={{ fontSize: 11.5 }}>
						{shortName(intent)}
					</span>
					{other ? (
						<>
							{" and "}
							<span className="callsign" style={{ fontSize: 11.5 }}>
								{shortName(other)}
							</span>
							{" both want "}
						</>
					) : (
						" wants a symbol another Intent holds: "
					)}
					<span className="symbol">{symbols[0] ?? "the same symbol"}</span>. A person is asked: {human.options.join(" / ")}.
				</span>
			</p>
		);
	}

	return (
		<section role="alertdialog" aria-label={`${callsign(intent)} needs you`} style={{ width: inline ? "100%" : 360, maxWidth: inline ? 480 : "100%", background: "#fff", border: "1px solid var(--rule)", borderLeft: "4px solid var(--redpen)", borderRadius: 3, padding: "12px 14px" }}>
			<p className="flex items-center gap-2" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
				<Bell size={16} weight="fill" color="var(--redpen)" aria-hidden="true" />
				{title}
			</p>
			<p style={GOAL_LINE} title={intent.goal}>
				<span className="callsign" style={{ fontSize: 12 }}>
					{callsign(intent)}
				</span>{" "}
				{brief(intent.goal)}
			</p>
			{stalemate && other ? (
				<p style={{ ...GOAL_LINE, margin: "4px 0 0" }} title={other.goal}>
					<span className="callsign" style={{ fontSize: 12 }}>
						{callsign(other)}
					</span>{" "}
					{brief(other.goal)}
				</p>
			) : null}
			{!stalemate ? (
				errors.length > 0 ? (
					<ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--redpen)" }}>
						{errors.map((line) => (
							<li key={line}>{named(line)}</li>
						))}
					</ul>
				) : (
					<p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>{named(human.message)}</p>
				)
			) : null}
			{applied ? (
				<p role="status" style={{ margin: "10px 0 0", fontSize: 13, fontWeight: 600, color: "var(--holds)" }}>
					{applied} applied
				</p>
			) : (
				<div className={inline && readOnly ? "flex gap-2" : "flex flex-col gap-2"} style={{ marginTop: 10 }}>
					{human.options.map((option) => (
						<div key={option} className="flex items-start gap-3">
							<Button size="sm" variant={option === "Abandon" ? "secondary-destructive" : "secondary"} disabled={readOnly || busy} onClick={() => void choose(option)} style={{ width: 84, flex: "none" }}>
								{option}
							</Button>
							{inline && readOnly ? null : <span style={{ fontSize: 12, color: "var(--ink-soft)", paddingTop: 4 }}>{EXPLAIN[option]}</span>}
						</div>
					))}
				</div>
			)}
			{readOnly && !applied ? <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>This is a recording, so the buttons are off. The recording shows what was chosen.</p> : null}
			{error ? (
				<p role="alert" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--redpen)" }}>
					{error}
				</p>
			) : null}
		</section>
	);
}

interface HumanCardsProps {
	cards: IntentView[];
	intents: Record<IntentId, IntentView>;
	readOnly: boolean;
	token: string;
	named: (text: string) => string;
	/** What an Intent is called on screen ("Agent 5", or its callsign). */
	nameOf?: (id: IntentId) => string;
	onNeedToken: () => void;
	/** Narrow screens: the cards sit at the top of the page's content instead of floating over its corner. */
	inline?: boolean;
}

/** One card for each Intent that is waiting for a person, stacked at the top right. */
export function HumanCards({ cards, intents, readOnly, token, named, nameOf, onNeedToken, inline = false }: HumanCardsProps) {
	if (cards.length === 0) {
		return null;
	}
	return (
		<div className="human-cards flex flex-col gap-2" style={inline ? { marginBottom: 12 } : { position: "fixed", top: 64, right: 12, zIndex: 20 }} aria-live="polite">
			{cards.map((intent) => {
				const otherId = waitingOn(intent);
				return <HumanCard key={intent.id} inline={inline} intent={intent} other={otherId === undefined ? undefined : intents[otherId]} readOnly={readOnly} token={token} named={named} {...(nameOf ? { nameOf } : {})} onNeedToken={onNeedToken} />;
			})}
		</div>
	);
}
