import { Button, Empty, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { AirplaneTakeoff } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PremiseEvent } from "../shared/events";
import type { IntentId } from "../shared/types";
import type { IntentDiff } from "./lib/diff";
import { readRecording } from "./lib/recording";
import { reduceAll } from "./lib/reduce";
import { useIntentDiff } from "./lib/useIntentDiff";
import { AbPanel, type AbResults } from "./components/AbPanel";
import { DispatchPanel } from "./components/DispatchPanel";
import { Drawer } from "./components/Drawer";
import { HumanCards } from "./components/HumanCards";
import { BuiltOn } from "./components/BuiltOn";
import { type Command, MoreSheet, Palette, Shortcuts } from "./components/Palette";
import { ScaleView } from "./components/ScaleView";
import { type RunKind, SimpleBar } from "./components/SimpleBar";
import { RunFigures } from "./components/RunFigures";
import { figuresFor } from "./lib/figures";
import { StoryBar } from "./components/StoryBar";
import { TapeView } from "./components/TapeView";
import { type LiveState, TopBar } from "./components/TopBar";
import { type StreamSource, useEventStream } from "./lib/useEventStream";
import { useViewState } from "./lib/useViewState";
import { explain, loadToken, resetDemo, saveToken } from "./lib/api";
import { openCards } from "./lib/chips";
import { captionAt } from "./lib/demo";
import { stepAt, storyFor } from "./lib/story";
import { replayOffsets, timeAtClock } from "./lib/stream";
import { advanceTape, buildTape, positionAt } from "./lib/tape";
import { callsign, lanesOf, layoutFor, OUTSIDE } from "./lib/view";

const LIVE_URL = "/api/events/ws";
type Mode = "replay" | "live";
/**
 * Three views. "tape" is the front page: every agent's Intent over time, with the run told as a
 * story above it in a replay. The other two are numbers: one larger run, and the comparison.
 */
type View = "tape" | "scale" | "ab";
const VIEW_LABEL: Record<View, string> = { tape: "The agents over time", scale: "At scale", ab: "Compared" };
/** How long a "Next" takes to carry the tape to the next step, whatever stretch of the run lies between. */
const STEP_TRAVEL_MS = 1100;
/** The fastest the tape is run to reach a step. A longer stretch simply takes a little longer. */
const STEP_MAX_SPEED = 40;

const query = new URLSearchParams(window.location.search);
/** `?live` opens on the live stream; otherwise the recorded run plays, which needs no backend. */
const startMode = (): Mode => (query.has("live") ? "live" : "replay");
/** `?frame=420` shows the recording as it stood after its first 420 events and stops there: a still, for screenshots and for pointing at one moment. */
const FRAME = Number(query.get("frame")) > 0 ? Math.floor(Number(query.get("frame"))) : null;
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
/** A sentence added to the story's first step for a run that needs it. */
const OPENING_NOTES: Record<string, string> = {
	live: "In this run the four agents are a live model (Gemini 3.5 Flash-Lite), not scripts. About five and a half minutes of waiting for the model are cut out.",
};
const DEMO = query.get("demo") ?? DEFAULT_RUN;
/** A touch screen (a phone, a tablet): "More" is a list of buttons there, not the keyboard's palette. */
const COARSE_POINTER = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
/** A lookup by a name that came from the address bar: only the table's own entries count ("constructor" is not a run). */
const own = <T,>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);
/**
 * What kind of run each demo recording is, said in the top bar: nobody should take scripted agents
 * for a model, or a model's run for the scripted one.
 */
const RUN_KINDS: Record<string, RunKind> = {
	main: { label: "Replay · scripted agents", extra: "real Artifacts", detail: "A recorded run on real Artifacts. The four agents replay prepared edits; forks, pushes, the ledger and the gate are the real system." },
	scale: { label: "Replay · scripted agents", extra: "real Artifacts", detail: "A recorded run on real Artifacts: twelve agents replaying prepared edits and a few hundred scripted workload Intents." },
	live: { label: "Replay · live model", extra: "real Artifacts", detail: "A recorded run on real Artifacts in which the four agents are a live model (Gemini 3.5 Flash-Lite), not scripts." },
};

// Recorded runs are bundled, each as a chunk of its own that is fetched only when it is asked for.
// A recording is the event log, or the log together with what each agent's Intent changed (see lib/recording.ts).
const RUNS = import.meta.glob<unknown>("../../demo/runs/*.json", { import: "default" });
const BUILT_IN = () => import("./fixtures/real-run.json").then((module) => module.default as unknown);
const AB_RESULTS: AbResults | null = Object.values(import.meta.glob<AbResults>("../../docs/ab-results.json", { import: "default", eager: true }))[0] ?? null;

export function App() {
	const [mode, setMode] = useState<Mode>(startMode);
	const [view, setView] = useState<View>("tape");
	// A replay opens held on the story's first step. "Play" lets it run by itself.
	const [paused, setPaused] = useState(true);
	// On the way to a step: where the tape is headed and how fast it is being run to get there.
	const [chase, setChase] = useState<{ target: number; speed: number } | null>(null);
	const [recording, setRecording] = useState<PremiseEvent[] | null>(null);
	const [recordedDiffs, setRecordedDiffs] = useState<Record<IntentId, IntentDiff>>({});
	const [selected, setSelected] = useState<IntentId | null>(null);
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
	const layout = layoutFor(windowWidth);
	const wide = layout === "wide";

	// The recording is a real run of the deployed system. It is loaded on demand, not bundled into the first paint.
	useEffect(() => {
		let current = true;
		const chosen = RUNS[`../../demo/runs/${DEMO}.json`];
		if (chosen === undefined && query.has("demo")) {
			setNotice(`There is no recorded run called "${DEMO}". Playing the built-in recording.`);
		}
		void (chosen ?? BUILT_IN)()
			.then((data) => {
				if (!current) {
					return;
				}
				const run = readRecording(data);
				setRecording(run.events);
				setRecordedDiffs(run.diffs);
			})
			.catch(() => {
				if (current) {
					// Shown instead of a skeleton that never ends.
					setRecording([]);
					setNotice("The recorded run could not be loaded. Reload the page to try again.");
				}
			});
		return () => {
			current = false;
		};
	}, []);

	// What the player plays: the recording, or nothing when a still frame was asked for.
	const playing = useMemo(() => (recording && FRAME === null ? recording : []), [recording]);
	const source = useMemo<StreamSource>(
		() => (mode === "live" ? { kind: "live", url: LIVE_URL } : chase === null ? { kind: "replay", events: playing, speed: 1, paused } : { kind: "replay", events: playing, speed: chase.speed, paused: false, until: chase.target }),
		[mode, playing, paused, chase],
	);
	const stream = useEventStream(source);
	// A still frame is the recording cut at that point, shown at once, with nothing playing.
	const still = useMemo(() => (FRAME !== null && recording && mode === "replay" ? recording.slice(0, FRAME) : null), [recording, mode]);
	const events = still ?? stream.events;
	const { connected, position, seek } = stream;
	const state = useViewState(events);
	const lanes = useMemo(() => lanesOf(state), [state]);
	// The run as a story: its steps, and plain names for the agents ("Agent 2"). Read from the whole recording, not from what has played so far.
	const story = useMemo(() => {
		if (mode !== "replay" || FRAME !== null || playing.length === 0) {
			return null;
		}
		const told = storyFor(playing, (at) => captionAt(playing, at, own(OPENINGS, DEMO)));
		// A run that differs from the front page's in a way that matters says so on its first step.
		const opening = own(OPENING_NOTES, DEMO);
		const [first, ...rest] = told.steps;
		return opening === undefined || first === undefined || rest.length === 0 ? told : { ...told, steps: [{ ...first, body: `${first.body} ${opening}`.trim() }, ...rest] };
	}, [mode, playing]);
	const names = story?.names;
	const stepIndex = story === null ? -1 : stepAt(story.steps, position);
	// Worked out only while the tape is on screen.
	// In a replay the whole run's length is known, so the tape's axis is fixed from the start and never changes scale.
	const recordingLength = playing.length > 0 ? (playing[playing.length - 1] as PremiseEvent).ts - (playing[0] as PremiseEvent).ts : 0;
	const builtTape = useMemo(() => (view === "tape" ? buildTape(events, state.intents, mode === "replay" && still === null ? recordingLength : undefined, names) : null), [view, events, state.intents, mode, still, recordingLength, names]);
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

	// A new recording (or the same one, started again) opens held on the story's first step.
	useEffect(() => {
		const first = story?.steps[0];
		if (first === undefined) {
			return;
		}
		setChase(null);
		setPaused(true);
		seek(first.at);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [playing]);
	// "Next" runs the tape forward to the step, fast enough to take about a second, and holds it there. "Back" simply shows the earlier step.
	const goToStep = useCallback(
		(index: number) => {
			const target = story?.steps[Math.min(Math.max(index, 0), (story?.steps.length ?? 1) - 1)];
			if (target === undefined) {
				return;
			}
			if (target.at <= position) {
				setChase(null);
				setPaused(true);
				seek(target.at);
				return;
			}
			const offsets = replayOffsets(playing);
			const ahead = (offsets[target.at - 1] ?? 0) - stream.clock();
			setChase({ target: target.at, speed: Math.min(STEP_MAX_SPEED, Math.max(1, ahead / STEP_TRAVEL_MS)) });
		},
		[story, position, playing, seek, stream.clock],
	);
	useEffect(() => {
		if (chase !== null && position >= chase.target) {
			setChase(null);
			setPaused(true);
		}
	}, [chase, position]);
	// A play-through that has reached the end is over: the button goes back to Play.
	useEffect(() => {
		if (!paused && chase === null && playing.length > 0 && position >= playing.length) {
			setPaused(true);
		}
	}, [paused, chase, position, playing.length]);
	const playThrough = useCallback(() => {
		setChase(null);
		if (position >= playing.length) {
			seek(0);
		}
		setPaused(false);
	}, [position, playing.length, seek]);
	// What an Intent is called on screen: "Agent 2" where the story has named the agents, else its callsign.
	const callsignOf = useCallback(
		(id: IntentId) => {
			const intent = state.intents[id];
			return names?.[id] ?? (intent ? callsign(intent) : id === OUTSIDE ? "a push to trunk" : id);
		},
		[state.intents, names],
	);

	// Messages from the backend name Intents by id. On screen they go by name.
	const named = useCallback(
		(text: string) => text.replace(/\bi[0-9a-z]{8}\b/g, (id) => (state.intents[id] ? callsignOf(id) : id)).replace(/\bintent ((?:T\d+|Agent \d+) )/g, "$1"),
		[state.intents, callsignOf],
	);

	const replayDone = mode === "replay" && recording !== null && events.length >= (FRAME ?? recording.length) && recording.length > 0;
	const live: LiveState = connected ? "live" : "reconnecting";
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

	// The page's keys: the story's (→ ← Space), j / k to open the next or previous agent's Intent, Esc to close it.
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
			if (mode === "replay" && view === "tape" && FRAME === null && !event.metaKey && !event.ctrlKey && !event.altKey && target?.closest("[role=dialog]") == null) {
				if (event.key === " ") {
					event.preventDefault();
					if (paused && chase === null) {
						playThrough();
					} else {
						setChase(null);
						setPaused(true);
					}
					return;
				}
				// → and ← walk the story, one step at a time.
				if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
					event.preventDefault();
					goToStep(stepIndex + (event.key === "ArrowRight" ? 1 : -1));
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
			document.querySelector<HTMLElement>(`button[data-node-id="strip-${ids[next]}"]`)?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lanes.agents, selected, mode, view, paused, chase, stepIndex, goToStep, playThrough]);

	const views = [
		{ value: "tape" as const, label: mode === "replay" ? "The story" : "Agents" },
		{ value: "scale" as const, label: "At scale" },
		{ value: "ab" as const, label: "Compared" },
	];
	const viewTabs = (
		<Tabs
			// The tab marker is measured when it moves. A new layout moves every tab, so start it afresh.
			key={`${layout}-${mode}`}
			size={mode === "replay" && layout !== "phone" ? "base" : "sm"}
			value={view}
			onValueChange={(value: string) => {
				setSelected(null);
				setView(views.find((candidate) => candidate.value === value)?.value ?? "tape");
			}}
			tabs={views}
		/>
	);
	const modeTabs = (
		<Tabs
			size="sm"
			value={mode}
			onValueChange={(value: string) => {
				setSelected(null);
				setChase(null);
				setMode(value === "live" ? "live" : "replay");
			}}
			tabs={[
				{ value: "replay", label: "Replay" },
				{ value: "live", label: "Live" },
			]}
		/>
	);

	// What the replay's bar says is on screen: the kind of run, or that this is one frame of it held still.
	const known = own(RUN_KINDS, DEMO);
	const runKind: RunKind | undefined = still !== null ? { label: `Still · after event ${still.length}`, extra: known?.label.replace(/^Replay · /, "") ?? "a recorded run", detail: "One moment of the recorded run, held still." } : known;
	const cards = useMemo(() => openCards(state), [state]);
	const figures = useMemo(() => figuresFor(events, state.intents, state.metrics), [events, state.intents, state.metrics]);
	const actions = useMemo<Command[]>(
		() => [
			{ id: "live", title: "Watch the live board", hint: "what the deployed Worker is doing now", run: () => setMode("live") },
			{ id: "replay", title: "Play the demo recording", hint: "the recorded run, told as a story", run: () => setMode("replay") },
			{ id: "dispatch", title: "Dispatch tasks", hint: "starts a run; needs the admin token", run: () => setDispatching(true) },
			{ id: "workload", title: "Run workload", hint: "scripted Intents; needs the admin token", run: () => setDispatching(true) },
			{
				id: "reset",
				title: "Reset demo",
				hint: "clears the live board; needs the admin token",
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
			// The three views have tabs, which a touch screen always shows; these are for the keyboard.
			{ id: "tape", title: "Show the agents over time", keyboardOnly: true, run: () => setView("tape") },
			{ id: "scale", title: "Show the larger run's numbers", keyboardOnly: true, run: () => setView("scale") },
			{ id: "ab", title: "Show the comparison", keyboardOnly: true, run: () => setView("ab") },
			{ id: "shortcuts", title: "Show keyboard shortcuts", keyboardOnly: true, run: () => setShortcutsOpen(true) },
		],
		[token],
	);
	// Whichever of "watch live" and "play the recording" is already on screen is not offered.
	const menuActions = useMemo(() => actions.filter((command) => command.id !== (mode === "live" ? "live" : "replay")), [actions, mode]);
	const plainMenu = layout !== "wide" || COARSE_POINTER;
	const jumpTo = useCallback((id: IntentId) => {
		setView("tape");
		setSelected(id);
	}, []);
	const jumps = useMemo<Command[]>(() => lanes.agents.map((intent) => ({ id: `jump-${intent.id}`, title: `Open ${callsignOf(intent.id)}`, run: () => jumpTo(intent.id) })), [lanes.agents, jumpTo, callsignOf]);

	// "Nothing in flight" is a state of the live board. A replay's first seconds, before its first Intent, are not it.
	const empty = mode === "live" && !loading && lanes.agents.length === 0 && lanes.workload === null;
	// A replay's length, and a way to move it to a moment: the tape's time axis is a slider.
	const seekToTime = (ms: number, nudge?: -1 | 1) => {
		const target = positionAt(playing, ms);
		setChase(null);
		// A step must move even when no event falls inside it (the recording has quiet stretches of several seconds).
		seek(nudge === 1 ? Math.max(position + 1, target) : nudge === -1 ? Math.max(1, Math.min(position - 1, target)) : target);
	};
	const toggleSelected = (id: IntentId) => setSelected((current) => (current === id ? null : id));
	// A card that needs a person sits above the tape: floating over its corner, it would cover "now", the part being watched.
	const humanCards = <HumanCards inline cards={cards} intents={state.intents} readOnly={mode === "replay"} token={token} named={named} nameOf={callsignOf} onNeedToken={() => setDispatching(true)} />;
	const storied = story !== null && story.steps.length > 0 && still === null;
	return (
		<div className="flex h-full flex-col" style={wide ? { minWidth: 1280 } : undefined}>
			{mode === "replay" ? (
				<SimpleBar layout={layout} views={viewTabs} onMore={() => setPaletteOpen(true)} {...(runKind === undefined ? {} : { kind: runKind })} />
			) : (
				<TopBar metrics={state.metrics} trunk={state.trunk.commit} live={live} views={viewTabs} layout={layout} mode={modeTabs} quiet={view === "ab"} onDispatch={() => setDispatching(true)} />
			)}
			{storied && view === "tape" && story !== null ? (
				<StoryBar steps={story.steps} index={stepIndex} playing={!paused && chase === null} moving={chase !== null} onStep={goToStep} onPlay={playThrough} onPause={() => setPaused(true)} onRestart={() => goToStep(0)} />
			) : null}
			{storied && view === "tape" && layout !== "phone" ? <RunFigures figures={figures} ended={replayDone} /> : null}
			{notice ? (
				<div role="status" className="flex items-center justify-between" style={{ padding: "6px 16px", background: "var(--surface)", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
					{notice}
					<Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
						Dismiss
					</Button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<main className="min-w-0 flex-1 overflow-auto" style={{ padding: wide ? "0 24px 8px" : "0 12px 8px" }} aria-label={VIEW_LABEL[view]}>
					{/* A spacer that scrolls away, so the tape's sticky header meets the top of the scroll area with nothing showing above it. */}
					<div aria-hidden="true" style={{ height: 12 }} />
					{view === "tape" ? humanCards : null}
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
					) : loading ? (
						<div className="flex flex-col gap-2" aria-label="Loading the run">
							{Array.from({ length: 4 }, (_, index) => (
								<div key={index} className="strip" style={{ width: 480, maxWidth: "100%", gridTemplateColumns: "6px 1fr", alignItems: "center" }}>
									<span className="strip-band" />
									<div style={{ padding: "0 12px" }}>
										<SkeletonLine />
									</div>
								</div>
							))}
						</div>
					) : empty || tape === null ? (
						<Empty
							icon={<AirplaneTakeoff size={40} />}
							title="No Intents in flight"
							description="Dispatch tasks to watch agents work."
							contents={
								<Button variant="primary" className="label-button" onClick={() => setDispatching(true)}>
									Dispatch tasks
								</Button>
							}
						/>
					) : (
						<TapeView
							tape={tape}
							workload={lanes.workload}
							layout={layout}
							selected={selected}
							onSelect={toggleSelected}
							live={mode === "live"}
							ended={mode === "replay" && (replayDone || still !== null)}
							{...(mode === "replay" && still === null && playing.length > 0 ? { total: recordingLength, onSeek: seekToTime } : {})}
							{...(storied && story !== null && story.steps[Math.max(0, stepIndex)] !== undefined && paused && chase === null ? { step: story.steps[Math.max(0, stepIndex)] as (typeof story.steps)[number] } : {})}
							{...(storied && story !== null ? { notes: story.notes } : {})}
						/>
					)}
					<div style={{ marginTop: 6 }}>
						<BuiltOn />
					</div>
				</main>
			</div>
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
			{/* A keyboard gets the palette (⌘K). A touch screen, or a narrow window, gets the same actions as buttons. */}
			{plainMenu ? <MoreSheet open={paletteOpen} onOpenChange={setPaletteOpen} actions={menuActions} jumps={jumps} /> : <Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={actions} jumps={jumps} />}
			<Shortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
			{selectedIntent && view === "tape" ? <Drawer intent={selectedIntent} events={events} callsignOf={callsignOf} named={named} diff={diff} replay={mode === "replay"} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
		</div>
	);
}
