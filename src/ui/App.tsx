import { Button, Empty, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { ArrowCounterClockwise, AirplaneTakeoff, Pause, Play, SkipForward } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PremiseEvent } from "../shared/events";
import type { IntentId, SymbolId } from "../shared/types";
import type { IntentDiff } from "./lib/diff";
import { readRecording } from "./lib/recording";
import { reduceAll } from "./lib/reduce";
import { useIntentDiff } from "./lib/useIntentDiff";
import { AbPanel, type AbResults } from "./components/AbPanel";
import { DispatchPanel } from "./components/DispatchPanel";
import { Drawer } from "./components/Drawer";
import { HumanCards } from "./components/HumanCards";
import { CompactLanes, Lanes } from "./components/Lanes";
import { BuiltOn, LedgerRail } from "./components/LedgerRail";
import { type Command, Palette, Shortcuts } from "./components/Palette";
import { ScaleView } from "./components/ScaleView";
import { TapeView } from "./components/TapeView";
import { type LiveState, TopBar } from "./components/TopBar";
import { type StreamSource, useEventStream } from "./lib/useEventStream";
import { useViewState } from "./lib/useViewState";
import { explain, loadToken, resetDemo, saveToken } from "./lib/api";
import { openCards, sharedSymbols } from "./lib/chips";
import { captionAt, nextStop } from "./lib/demo";
import { replayOffsets, timeAtClock } from "./lib/stream";
import { advanceTape, buildTape, positionAt } from "./lib/tape";
import { callsign, lanesOf, layoutFor, ledgerRows, OUTSIDE } from "./lib/view";

const LIVE_URL = "/api/events/ws";
const SPEEDS = [1, 2, 4];
type Mode = "replay" | "live";
type View = "lanes" | "tape" | "ledger" | "scale" | "ab";
const VIEWS: { value: View; label: string }[] = [
	{ value: "lanes", label: "Lanes" },
	{ value: "tape", label: "Tape" },
	// On a wide screen the ledger is the rail beside the lanes. On a narrow one it is a view of its own.
	{ value: "ledger", label: "Ledger" },
	{ value: "scale", label: "Scale" },
	{ value: "ab", label: "A/B" },
];
const VIEW_LABEL: Record<View, string> = { lanes: "Strip board", tape: "Tape", ledger: "Ledger", scale: "Scale", ab: "A/B results" };
/** The views that are about Intents one by one: a row can be selected, and its drawer opens. */
const INTENT_VIEWS: readonly View[] = ["lanes", "tape"];
/** How long a "⏩ compressed" marker stays in the top bar. */
const MARKER_MS = 3000;

const query = new URLSearchParams(window.location.search);
/** `?live` opens on the live stream; otherwise the recorded run plays, which needs no backend. */
const startMode = (): Mode => (query.has("live") ? "live" : "replay");
/** `?frame=420` shows the recording as it stood after its first 420 events and stops there: a still, for screenshots and for pointing at one moment. */
const FRAME = query.has("frame") ? Math.max(0, Number(query.get("frame")) || 0) : null;
/**
 * Which recorded run plays: `?demo=<name>` is demo/runs/<name>.json. With nothing asked for it is
 * "main", so the bare address and `/?demo=main` show the same run and the same numbers.
 */
const DEFAULT_RUN = "main";
/**
 * The front-page run is small on purpose (four agents, one break). The Scale tab is about volume,
 * so beside that run it shows the end of this other one: twelve agents and a few hundred workload Intents.
 */
const SCALE_RUN = "scale";
/** What a demo recording's first caption says, where the usual sentence would leave out something that matters. */
const OPENINGS: Record<string, string> = {
	live: "A recorded run on real Artifacts in which the four agents are a live model (Gemini 3.5 Flash-Lite), not scripts. About five and a half minutes of waiting for the model are cut out.",
};
const DEMO = query.get("demo") ?? DEFAULT_RUN;

// Recorded runs are bundled, each as a chunk of its own that is fetched only when it is asked for.
// A recording is the event log, or the log together with what each agent's Intent changed (see lib/recording.ts).
const RUNS = import.meta.glob<unknown>("../../demo/runs/*.json", { import: "default" });
const BUILT_IN = () => import("./fixtures/real-run.json").then((module) => module.default as unknown);
const AB_RESULTS: AbResults | null = Object.values(import.meta.glob<AbResults>("../../docs/ab-results.json", { import: "default", eager: true }))[0] ?? null;

export function App() {
	const [mode, setMode] = useState<Mode>(startMode);
	const [view, setView] = useState<View>("lanes");
	const [speed, setSpeed] = useState(1);
	const [paused, setPaused] = useState(false);
	const [marker, setMarker] = useState<string | undefined>(undefined);
	const [run, setRun] = useState(0);
	const [recording, setRecording] = useState<PremiseEvent[] | null>(null);
	const [recordedDiffs, setRecordedDiffs] = useState<Record<IntentId, IntentDiff>>({});
	const [selected, setSelected] = useState<IntentId | null>(null);
	const [hoverSymbol, setHoverSymbol] = useState<SymbolId | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [token, setTokenState] = useState(loadToken);
	const [dispatching, setDispatching] = useState(false);
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const setToken = useCallback((value: string) => {
		setTokenState(value);
		saveToken(value);
	}, []);
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const onResize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	// The board is what is left of the window after the ledger rail (320) and the board's own padding (32).
	// 16 more for a scrollbar, which appears when the drawer is open.
	const boardWidth = Math.max(1280, windowWidth) - 320 - 32 - 16;
	const layout = layoutFor(windowWidth);
	const wide = layout === "wide";
	const views = useMemo(() => VIEWS.filter((candidate) => !wide || candidate.value !== "ledger"), [wide]);
	// Widening the window puts the ledger back beside the lanes, so there is no Ledger view to be on.
	useEffect(() => {
		if (wide) {
			setView((current) => (current === "ledger" ? "lanes" : current));
		}
	}, [wide]);

	// The recording is a real run of the deployed system. It is loaded on demand, not bundled into the first paint.
	useEffect(() => {
		let current = true;
		const chosen = RUNS[`../../demo/runs/${DEMO}.json`];
		if (chosen === undefined && query.has("demo")) {
			setNotice(`There is no recorded run called "${DEMO}". Playing the built-in recording.`);
		}
		void (chosen ?? BUILT_IN)().then((data) => {
			if (!current) {
				return;
			}
			const run = readRecording(data);
			setRecording(run.events);
			setRecordedDiffs(run.diffs);
		});
		return () => {
			current = false;
		};
	}, []);

	// A new array each time "Play again" is pressed, which is what tells the player to start over.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const playing = useMemo(() => (recording && FRAME === null ? [...recording] : []), [recording, run]);
	const source = useMemo<StreamSource>(
		() => (mode === "live" ? { kind: "live", url: LIVE_URL } : { kind: "replay", events: playing, speed, paused }),
		[mode, playing, speed, paused],
	);
	const stream = useEventStream(source);
	// A still frame is the recording cut at that point, shown at once, with nothing playing.
	const still = useMemo(() => (FRAME !== null && recording && mode === "replay" ? recording.slice(0, FRAME) : null), [recording, mode]);
	const events = still ?? stream.events;
	const { connected, position, seek } = stream;
	const state = useViewState(events);
	const lanes = useMemo(() => lanesOf(state), [state]);
	const rows = useMemo(() => ledgerRows(state), [state]);
	const shared = useMemo(() => sharedSymbols(state), [state]);
	// Worked out only while the tape is on screen.
	// In a replay the whole run's length is known, so the tape's axis is fixed from the start and never changes scale.
	const recordingLength = playing.length > 0 ? (playing[playing.length - 1] as PremiseEvent).ts - (playing[0] as PremiseEvent).ts : 0;
	const builtTape = useMemo(() => (view === "tape" ? buildTape(events, state.intents, mode === "replay" && still === null ? recordingLength : undefined) : null), [view, events, state.intents, mode, still, recordingLength]);
	// Between events the replay's clock still runs. The tape follows it frame by frame, so time glides instead of jumping.
	const replayTimes = useMemo(() => ({ offsets: replayOffsets(playing), times: playing.map((event) => event.ts - (playing[0]?.ts ?? 0)) }), [playing]);
	const [glide, setGlide] = useState(0);
	const gliding = view === "tape" && mode === "replay" && still === null && playing.length > 0;
	useEffect(() => {
		if (!gliding) {
			return;
		}
		let frame = 0;
		const step = () => {
			setGlide(timeAtClock(replayTimes.offsets, replayTimes.times, stream.position, stream.clock()));
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [gliding, replayTimes, stream.position, stream.clock]);
	const tape = useMemo(() => (builtTape === null ? null : gliding ? advanceTape(builtTape, glide) : builtTape), [builtTape, gliding, glide]);

	// A marker for time cut out of the recording shows for three seconds, then goes.
	const markerCount = state.markers.length;
	const latestMarker = state.markers.at(-1);
	useEffect(() => {
		if (latestMarker === undefined) {
			setMarker(undefined);
			return;
		}
		setMarker(latestMarker);
		const timer = setTimeout(() => setMarker(undefined), MARKER_MS);
		return () => clearTimeout(timer);
	}, [markerCount, latestMarker]);
	const callsignOf = useCallback(
		(id: IntentId) => {
			const intent = state.intents[id];
			return intent ? callsign(intent) : id === OUTSIDE ? "a push to trunk" : id;
		},
		[state.intents],
	);

	// Messages from the backend name Intents by id. On screen they go by callsign.
	const named = useCallback(
		(text: string) => text.replace(/\bi[0-9a-z]{8}\b/g, (id) => (state.intents[id] ? callsign(state.intents[id] as (typeof state.intents)[string]) : id)).replace(/\bintent (T\d+ )/g, "$1"),
		[state.intents],
	);

	const replayDone = mode === "replay" && recording !== null && events.length >= (FRAME ?? recording.length) && recording.length > 0;
	const live: LiveState = mode === "live" ? (connected ? { kind: "live" } : { kind: "reconnecting" }) : still !== null ? { kind: "still", at: still.length } : { kind: "replay", speed, done: replayDone, paused };
	const loading = mode === "live" ? !connected && events.length === 0 : recording === null;
	const selectedIntent = selected === null ? undefined : state.intents[selected];

	// The larger run, loaded the first time the Scale tab is opened while the front-page run is playing.
	const [scaleRun, setScaleRun] = useState<PremiseEvent[] | null>(null);
	const scaleFromOtherRun = mode === "replay" && DEMO === DEFAULT_RUN && RUNS[`../../demo/runs/${SCALE_RUN}.json`] !== undefined;
	useEffect(() => {
		if (view !== "scale" || !scaleFromOtherRun || scaleRun !== null) {
			return;
		}
		let current = true;
		void RUNS[`../../demo/runs/${SCALE_RUN}.json`]?.().then((data) => current && setScaleRun(readRecording(data).events));
		return () => {
			current = false;
		};
	}, [view, scaleFromOtherRun, scaleRun]);
	const scaleState = useMemo(() => (scaleRun === null ? null : reduceAll(scaleRun)), [scaleRun]);
	const diff = useIntentDiff(selectedIntent, mode, recordedDiffs);

	// j / k move between strips, Enter opens the drawer, Esc closes it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			if (typing && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPaletteOpen(true);
				return;
			}
			if (event.key === "?") {
				setShortcutsOpen(true);
				return;
			}
			// The player's keys. They belong to a replay, and stay out of the way of a dialog.
			if (mode === "replay" && FRAME === null && !event.metaKey && !event.ctrlKey && !event.altKey && target?.closest("[role=dialog]") == null) {
				if (event.key === " ") {
					event.preventDefault();
					setPaused((now) => !now);
					return;
				}
				if (event.key === "ArrowRight") {
					event.preventDefault();
					seek(nextStop(playing, position));
					return;
				}
				if (event.key === "1" || event.key === "2" || event.key === "4") {
					setSpeed(Number(event.key));
					return;
				}
			}
			if (event.key === "Escape") {
				setSelected(null);
				return;
			}
			if (event.key !== "j" && event.key !== "k") {
				return;
			}
			const ids = lanes.agents.map((intent) => intent.id);
			if (ids.length === 0) {
				return;
			}
			const at = selected === null ? -1 : ids.indexOf(selected);
			const next = event.key === "j" ? Math.min(ids.length - 1, at + 1) : Math.max(0, at <= 0 ? 0 : at - 1);
			setSelected(ids[next] ?? null);
			document.querySelector<HTMLElement>(`[data-node-id="strip-${ids[next]}"] .strip-open, button[data-node-id="strip-${ids[next]}"]`)?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lanes.agents, selected, mode, playing, position, seek]);

	const modeTabs = (
			<Tabs
				size="sm"
				value={mode}
				onValueChange={(value: string) => {
					setSelected(null);
					setPaused(false);
					setMode(value === "live" ? "live" : "replay");
				}}
				tabs={[
					{ value: "replay", label: "Replay" },
					{ value: "live", label: "Live" },
				]}
			/>
	);
	const transport =
			mode === "replay" ? (
				<>
					<Button variant="secondary" size="sm" aria-label={`Playback speed ${speed}×. Change it.`} title="Playback speed. Click to change it, or press 1, 2 or 4." onClick={() => setSpeed((now) => SPEEDS[(SPEEDS.indexOf(now) + 1) % SPEEDS.length] ?? 1)} style={{ minWidth: 40 }}>
						<span className="callsign" style={{ fontSize: 14 }}>
							{speed}×
						</span>
					</Button>
					{FRAME === null ? (
						<Button variant="ghost" size="sm" shape="square" aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume (Space)" : "Pause (Space)"} onClick={() => setPaused((now) => !now)}>
							{paused ? <Play size={16} /> : <Pause size={16} />}
						</Button>
					) : null}
					{FRAME === null ? (
						<Button variant="secondary" size="sm" aria-label="Next moment" title="Jump to the next key moment (→)" onClick={() => seek(nextStop(playing, position))}>
							<SkipForward size={16} />
							{layout === "phone" ? null : (
								<span>
									Next<span className="wide-only"> moment</span>
								</span>
							)}
						</Button>
					) : null}
					<Button
						variant="ghost"
						size="sm"
						shape="square"
						aria-label="Play again"
						title="Play the recording again from the start"
						onClick={() => {
							setPaused(false);
							setRun((count) => count + 1);
						}}
					>
						<ArrowCounterClockwise size={16} />
					</Button>
				</>
			) : null;

	const cards = useMemo(() => openCards(state), [state]);
	const actions = useMemo<Command[]>(
		() => [
			{ id: "dispatch", title: "Dispatch tasks", run: () => setDispatching(true) },
			{ id: "workload", title: "Run workload", run: () => setDispatching(true) },
			{
				id: "reset",
				title: "Reset demo",
				run: () => {
					if (token === "") {
						setDispatching(true);
						return;
					}
					resetDemo(token).then(
						(result) => setNotice(`Reset. Trunk is now ${result.trunk}.`),
						(error: unknown) => setNotice(explain(error)),
					);
				},
			},
			{ id: "live", title: "Watch live", run: () => setMode("live") },
			{ id: "replay", title: "Play the recording", run: () => setMode("replay") },
			{ id: "lanes", title: "Show the lanes", run: () => setView("lanes") },
			{ id: "tape", title: "Show the tape", run: () => setView("tape") },
			{ id: "scale", title: "Show the scale view", run: () => setView("scale") },
			{ id: "ab", title: "Show the A/B results", run: () => setView("ab") },
			{ id: "shortcuts", title: "Show keyboard shortcuts", run: () => setShortcutsOpen(true) },
		],
		[token],
	);
	const jumpTo = useCallback((id: IntentId) => {
		setView((current) => (INTENT_VIEWS.includes(current) ? current : "lanes"));
		setSelected(id);
	}, []);
	const jumps = useMemo<Command[]>(() => lanes.agents.map((intent) => ({ id: `jump-${intent.id}`, title: `Jump to ${callsign(intent)}`, run: () => jumpTo(intent.id) })), [lanes.agents, jumpTo]);

	// In a replay, one sentence under the bar says what the screen is showing: the latest key moment in plain words.
	const caption = useMemo(() => (mode === "replay" && still === null && playing.length > 0 ? captionAt(playing, position, OPENINGS[DEMO]) : null), [mode, still, playing, position]);
	const empty = !loading && lanes.agents.length === 0 && lanes.workload === null;
	// "Nothing in flight" is only true once every Intent has landed or stopped, not while they are still planning.
	const settled = useMemo(() => !empty && !loading && Object.values(state.intents).every((intent) => intent.status === "landed" || intent.status === "failed" || intent.status === "escalated"), [empty, loading, state.intents]);
	// A replay's length, and a way to move it to a moment: the tape's time axis is a slider.
	const seekToTime = (ms: number, nudge?: -1 | 1) => {
		const target = positionAt(playing, ms);
		// A step must move even when no event falls inside it (the recording has quiet stretches of several seconds).
		seek(nudge === 1 ? Math.max(position + 1, target) : nudge === -1 ? Math.max(1, Math.min(position - 1, target)) : target);
	};
	const toggleSelected = (id: IntentId) => setSelected((current) => (current === id ? null : id));
	// On the tape a floating card would sit on "now", the part being watched: there it goes above the tape instead.
	// In a replay the cards are notes, not things to act on: they sit in the page, where they cannot cover the caption.
	// On the wide Lanes view they go at the top of the ledger rail, so the twelve strips still fit the screen.
	const cardsInRail = wide && view === "lanes" && mode === "replay";
	const cardsInline = (!wide || view === "tape" || mode === "replay") && !cardsInRail;
	const humanCards = <HumanCards inline={cardsInline || cardsInRail} cards={cards} intents={state.intents} readOnly={mode === "replay"} token={token} named={named} onNeedToken={() => setDispatching(true)} />;
	return (
		<div className="flex h-full flex-col" style={wide ? { minWidth: 1280 } : undefined}>
			<TopBar
				metrics={state.metrics}
				trunk={state.trunk.commit}
				live={live}
				// The tape marks cut time on its own trunk line, so the pill would only cover its playhead.
				// With a caption on screen the marker sits at the end of the caption's line, where it cannot cover it.
				marker={view === "tape" || (caption !== null && INTENT_VIEWS.includes(view)) ? undefined : marker}
				views={
					<Tabs
						// The tab marker is measured when it moves. A new layout moves every tab, so start it afresh.
						key={layout}
						size="sm"
						value={view}
						onValueChange={(value: string) => {
							setSelected(null);
							setView(views.find((candidate) => candidate.value === value)?.value ?? "lanes");
						}}
						tabs={views}
					/>
				}
				layout={layout}
				mode={modeTabs}
				transport={transport}
				// The A/B tab is about a different pair of runs: this recording's counters beside its table only confuse.
				quiet={view === "ab" || (view === "scale" && scaleFromOtherRun)}
				// Watching a recording, dispatching is not the next thing to do: it needs the admin token and a live Worker.
				dispatchQuiet={mode === "replay"}
				onDispatch={() => setDispatching(true)}
			/>
			{caption !== null && INTENT_VIEWS.includes(view) ? (
				<div className="caption">
					<p role="status" aria-live="polite" style={{ margin: 0, flex: 1, minWidth: 0 }}>
						{caption}
					</p>
					{marker && view !== "tape" ? (
						<span role="status" style={{ flex: "none", fontSize: 12, color: "var(--ink-soft)", border: "1px solid var(--rule)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap" }}>
							{marker}
						</span>
					) : null}
				</div>
			) : null}
			{notice ? (
				<div role="status" className="flex items-center justify-between" style={{ padding: "6px 16px", background: "#fff", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
					{notice}
					<Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
						Dismiss
					</Button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<main className="min-w-0 flex-1 overflow-auto" style={{ padding: !wide ? 12 : view === "lanes" ? "8px 16px" : 16 }} aria-label={VIEW_LABEL[view]}>
					{cardsInline && INTENT_VIEWS.includes(view) ? humanCards : null}
					{view === "ab" ? (
						<AbPanel results={AB_RESULTS} />
					) : view === "scale" ? (
						scaleFromOtherRun ? (
							scaleRun === null || scaleState === null ? (
								<p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading the larger run…</p>
							) : (
								<ScaleView events={scaleRun} metrics={scaleState.metrics} intents={scaleState.intents} otherRun={{ name: SCALE_RUN, href: `/?demo=${SCALE_RUN}` }} />
							)
						) : (
							<ScaleView events={events} metrics={state.metrics} intents={state.intents} />
						)
					) : view === "tape" && tape !== null && !loading && !empty ? (
						<TapeView
							tape={tape}
							workload={lanes.workload}
							layout={layout}
							selected={selected}
							onSelect={toggleSelected}
							live={mode === "live"}
							ended={mode === "replay" && (replayDone || still !== null)}
							{...(mode === "replay" && still === null && playing.length > 0 ? { total: recordingLength, onSeek: seekToTime } : {})}
						/>
					) : view === "ledger" ? (
						<LedgerRail fill rows={rows} quiet={settled} callsignOf={callsignOf} hoverSymbol={hoverSymbol} onHoverSymbol={setHoverSymbol} />
					) : loading ? (
						<div className="flex flex-col gap-2" aria-label="Loading the run">
							{Array.from({ length: 8 }, (_, index) => (
								<div key={index} className="strip" style={{ width: 480, maxWidth: "100%", gridTemplateColumns: "6px 1fr", alignItems: "center" }}>
									<span className="strip-band" />
									<div style={{ padding: "0 12px" }}>
										<SkeletonLine />
									</div>
								</div>
							))}
						</div>
					) : empty ? (
						<Empty
							icon={<AirplaneTakeoff size={40} />}
							title="No intents in flight"
							description="Dispatch tasks to watch agents work."
							contents={
								<Button variant="primary" onClick={() => setDispatching(true)}>
									Dispatch tasks
								</Button>
							}
						/>
					) : wide ? (
						<Lanes lanes={lanes} width={boardWidth} shared={shared} selected={selected} hoverSymbol={hoverSymbol} onSelect={toggleSelected} onHoverSymbol={setHoverSymbol} />
					) : (
						<CompactLanes lanes={lanes} stacked={layout === "phone"} shared={shared} selected={selected} hoverSymbol={hoverSymbol} onSelect={toggleSelected} onHoverSymbol={setHoverSymbol} />
					)}
					{wide ? null : (
						<div style={{ marginTop: 12 }}>
							<BuiltOn />
						</div>
					)}
				</main>
				{wide && view === "lanes" ? <LedgerRail rows={rows} quiet={settled} callsignOf={callsignOf} hoverSymbol={hoverSymbol} onHoverSymbol={setHoverSymbol} notice={cardsInRail && cards.length > 0 ? humanCards : null} /> : null}
			</div>
			{cardsInline || cardsInRail ? null : humanCards}
			{dispatching ? (
				<DispatchPanel
					token={token}
					onToken={setToken}
					onClose={() => setDispatching(false)}
					onStarted={() => {
						setSelected(null);
						setMode("live");
					}}
				/>
			) : null}
			<Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} jumps={jumps} />
			<Shortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
			{selectedIntent && INTENT_VIEWS.includes(view) ? <Drawer intent={selectedIntent} events={events} callsignOf={callsignOf} named={named} diff={diff} replay={mode === "replay"} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
		</div>
	);
}
