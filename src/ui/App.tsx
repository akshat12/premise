import { Button, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PremiseEvent } from "../shared/events";
import type { IntentId } from "../shared/types";
import type { IntentDiff } from "./lib/diff";
import { readRecording } from "./lib/recording";
import { reduceAll } from "./lib/reduce";
import { useIntentDiff } from "./lib/useIntentDiff";
import { AbPanel, type AbResults } from "./components/AbPanel";
import { SlidesCard, SlidesOverlay } from "./components/Slides";
import { WorkloadList } from "./components/WorkloadList";
import { WORKLOAD_LIST, workloadLines } from "./lib/workload";
import { DRAWER_OUT_MS, usePresence } from "./lib/usePresence";
import { browserMemory, dismissPhoneNote, isFirstVisit, phoneNoteDismissed, rememberVisit } from "./lib/firstVisit";
import { DispatchPanel } from "./components/DispatchPanel";
import { Drawer } from "./components/Drawer";
import { HumanCards } from "./components/HumanCards";
import { LiveBar } from "./components/LiveBar";
import { BuiltOn } from "./components/BuiltOn";
import { type Command, MoreSheet, Palette, Shortcuts } from "./components/Palette";
import { ScaleView } from "./components/ScaleView";
import { type RunKind, SimpleBar, GITHUB_URL } from "./components/SimpleBar";
import { RecentRuns } from "./components/RecentRuns";
import { RunFigures } from "./components/RunFigures";
import { figuresFor } from "./lib/figures";
import { StoryBar } from "./components/StoryBar";
import { TapeView } from "./components/TapeView";
import { type StreamSource, useEventStream } from "./lib/useEventStream";
import { useViewState } from "./lib/useViewState";
import { explain, loadToken, resetDemo, saveToken } from "./lib/api";
import { openCards } from "./lib/chips";
import { captionAt } from "./lib/demo";
import { liveCaption, runOver, runSettled, startOffer } from "./lib/live";
import { useLiveStatus } from "./lib/useLiveStatus";
import { stepAt, storyFor } from "./lib/story";
import { replayOffsets, timeAtClock } from "./lib/stream";
import { fetchPastRun } from "./lib/pastRun";
import { advanceTape, buildTape, easeSpan, followClock, positionAt, spanFor } from "./lib/tape";
import { callsign, lanesOf, layoutFor, OUTSIDE } from "./lib/view";

// Not /api/events/ws, which ad blockers refuse (see BOARD_HISTORY in worker/routes/events.ts).
const LIVE_URL = "/api/board/history/ws";
/**
 * Three tabs. "Demo" plays a recorded run as a story, and nothing else. "Live" is the same page for
 * the deployed Worker's board, with a button that starts a run on it. "Results" is what was
 * measured: the same work under three rules, and one larger run. (The numbers were under the story
 * for an evening; the user wanted the Demo page clean.)
 */
type Tab = "demo" | "live" | "results";
/** Where the events on screen come from: a recording, or the Worker. Results has a recording behind it, unseen. */
type Mode = "replay" | "live";
const TABS: { value: Tab; label: string }[] = [
	{ value: "demo", label: "Demo" },
	{ value: "live", label: "Live" },
	{ value: "results", label: "Results" },
];
/** How long a "Next" takes to carry the tape to the next step, whatever stretch of the run lies between. */
const STEP_TRAVEL_MS = 1100;
/** The fastest the tape is run to reach a step. A longer stretch simply takes a little longer. */
const STEP_MAX_SPEED = 40;

const query = new URLSearchParams(window.location.search);
/** `?live` opens on the live stream; otherwise the recorded run plays, which needs no backend. */
const startTab = (): Tab => (query.has("live") ? "live" : query.has("results") ? "results" : "demo");
/** `?frame=420` shows the recording as it stood after its first 420 events and stops there: a still, for screenshots and for pointing at one moment. */
const FRAME = Number(query.get("frame")) > 0 ? Math.floor(Number(query.get("frame"))) : null;
/**
 * Which recorded run plays: `?demo=<name>` is demo/runs/<name>.json. With nothing asked for it is
 * "main", so the bare address and `/?demo=main` show the same run and the same numbers.
 */
const DEFAULT_RUN = "main";
/**
 * The front-page run is small on purpose (four agents, one break). Under it the page shows the
 * end of this other one, which is about volume: twelve agents and a few hundred workload Intents.
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
/** The same, for a past run of the live board, whatever its number. */
const PAST_RUN_NOTE = "This is a past run of the live board, played back from the Worker's record of it.";
const PAST_RUN_KIND: RunKind = { label: "Replay · a past live run", extra: "from the Worker's record", detail: "A run of the live board that the Worker kept when the board was cleared, played back from its event log. What each Intent changed is read from the trunk the run left behind, as it landed there." };
/** Added to the last step of the front-page run. */
const WHAT_NEXT = "The Results tab has the numbers. The Live tab runs it for real.";
/**
 * `?run=12` plays a past run of the live board from the Worker's record of it (see the Results tab's
 * list). It is a recording like the others, only fetched from the Worker instead of bundled.
 */
const PAST_RUN = /^[1-9]\d{0,8}$/.test(query.get("run") ?? "") ? Number(query.get("run")) : null;
const DEMO = PAST_RUN !== null ? `run-${PAST_RUN}` : (query.get("demo") ?? DEFAULT_RUN);

/**
 * `?admin` shows the owner's tools under "More": dispatching by hand, the workload, and reset. A
 * visitor never needs them (the Live tab's Start button is the whole of what a visitor can do) and
 * every one of them asks for the admin token anyway, so this is tidiness, not a lock.
 */
const ADMIN = query.has("admin");
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
/** The same, for the Live tab. `store` is where the Worker keeps its repos. */
const liveKind = (store: string | null): RunKind =>
	store === "memory"
		? { label: "Live · scripted agents", extra: "in-memory repos", detail: "A local build: the Worker on this machine, with repos held in memory. The agents replay prepared edits; the ledger and the gate are the real system." }
		: { label: "Live · scripted agents", extra: "real Artifacts", detail: "The deployed Worker, now. The agents replay prepared edits; forks, pushes, the ledger and the gate are the real system, on Cloudflare Artifacts." };

// Recorded runs are bundled, each as a chunk of its own that is fetched only when it is asked for.
// A recording is the event log, or the log together with what each agent's Intent changed (see lib/recording.ts).
const RUNS = import.meta.glob<unknown>("../../demo/runs/*.json", { import: "default" });
const BUILT_IN = () => import("./fixtures/real-run.json").then((module) => module.default as unknown);
const AB_RESULTS: AbResults | null = Object.values(import.meta.glob<AbResults>("../../docs/ab-results.json", { import: "default", eager: true }))[0] ?? null;

export function App() {
	const [tab, setTab] = useState<Tab>(startTab);
	// The slides that explain Premise, opened over the page; and the card that offers them, once, on a first visit.
	const [slidesOpen, setSlidesOpen] = useState(false);
	// The phone note ("best viewed on a computer"), once dismissed, stays dismissed.
	const [phoneNoteGone, setPhoneNoteGone] = useState(() => phoneNoteDismissed(browserMemory()));
	const [slidesCard, setSlidesCard] = useState(() => isFirstVisit(browserMemory(), window.location.search));
	useEffect(() => {
		// Shown is shown: the next visit does not get the card, whether or not this one answered it.
		if (slidesCard && !rememberVisit(browserMemory())) {
			setSlidesCard(false);
		}
	}, [slidesCard]);
	const openSlides = useCallback(() => {
		setSlidesCard(false);
		setSlidesOpen(true);
	}, []);
	const closeSlides = useCallback(() => setSlidesOpen(false), []);
	const mode: Mode = tab === "live" ? "live" : "replay";
	const onResults = tab === "results";
	// A replay opens held on the story's first step. "Play" lets it run by itself.
	const [paused, setPaused] = useState(true);
	// On the way to a step: where the tape is headed and how fast it is being run to get there.
	const [chase, setChase] = useState<{ target: number; speed: number } | null>(null);
	const [recording, setRecording] = useState<PremiseEvent[] | null>(null);
	const [recordedDiffs, setRecordedDiffs] = useState<Record<IntentId, IntentDiff>>({});
	// The past run being played, by its number. null when none was asked for, or the Worker no longer has it and the demo recording plays in its place.
	const [pastRun, setPastRun] = useState<number | null>(PAST_RUN);
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
		const bundled = RUNS[`../../demo/runs/${DEMO}.json`];
		if (bundled === undefined && query.has("demo") && PAST_RUN === null) {
			setNotice(`There is no recorded run called "${DEMO}". Playing the built-in recording.`);
		}
		// A past run of the live board comes from the Worker. If it is no longer kept there, the demo recording plays.
		const chosen =
			PAST_RUN === null
				? bundled
				: () =>
						fetchPastRun(PAST_RUN).catch(() => {
							if (current) {
								setPastRun(null);
								setNotice(`Run ${PAST_RUN} is not in the Worker's record any more. Playing the demo recording.`);
							}
							return (RUNS[`../../demo/runs/${DEFAULT_RUN}.json`] ?? BUILT_IN)();
						});
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
		const opening = pastRun !== null ? PAST_RUN_NOTE : own(OPENING_NOTES, DEMO);
		// The front-page run's last step says where to go next: the numbers are under the tape, and the same thing can be run live.
		const closing = DEMO === DEFAULT_RUN ? WHAT_NEXT : undefined;
		const steps = told.steps.map((step, index) => {
			const add = index === 0 && told.steps.length > 1 ? opening : step.id === "end" ? closing : undefined;
			return add === undefined ? step : { ...step, body: `${step.body} ${add}`.trim() };
		});
		return { ...told, steps };
	}, [mode, playing, pastRun]);
	// The live board has no script to read ahead in: its story is whatever the log says so far.
	const liveStory = useMemo(() => (mode === "live" ? storyFor(events) : null), [mode, events]);
	const names = (story ?? liveStory)?.names;
	const stepIndex = story === null ? -1 : stepAt(story.steps, position);
	// In a replay the whole run's length is known, so the tape's axis is fixed from the start and never changes scale.
	const recordingLength = playing.length > 0 ? (playing[playing.length - 1] as PremiseEvent).ts - (playing[0] as PremiseEvent).ts : 0;
	const builtTape = useMemo(() => buildTape(events, state.intents, mode === "replay" && still === null ? recordingLength : undefined, names), [events, state.intents, mode, still, recordingLength, names]);
	// Between events the replay's clock still runs. The tape follows it frame by frame, so time glides instead of jumping.
	const replayTimes = useMemo(() => ({ offsets: replayOffsets(playing), times: playing.map((event) => event.ts - (playing[0]?.ts ?? 0)) }), [playing]);
	const [glide, setGlide] = useState(0);
	const gliding = mode === "replay" && still === null && playing.length > 0;
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
	// The Live tab: whether a run may be started. With no Worker to ask, there is no board to wait for either.
	const control = useLiveStatus(mode === "live");
	// The live board does the same against the Worker's clock: between events its "now" keeps moving
	// instead of jumping to each event as it arrives (they come in bursts). How far the Worker's clock is
	// ahead of this one is learnt from the live status and from the events themselves (an event cannot be
	// newer than the Worker's clock when it arrives), keeping the largest lead seen, so the clock never steps back.
	const lead = useRef<number | null>(null);
	const learn = (sample: number) => {
		lead.current = lead.current === null ? sample : Math.max(lead.current, sample);
	};
	const newestTs = events.at(-1)?.ts;
	const runStart = events[0]?.ts;
	useEffect(() => {
		if (mode === "live" && newestTs !== undefined) {
			learn(newestTs - Date.now());
		}
	}, [mode, newestTs]);
	useEffect(() => {
		if (mode === "live" && control.status !== null) {
			learn(control.now - Date.now());
		}
	}, [mode, control.now, control.status]);
	const [liveClock, setLiveClock] = useState<{ start: number; now: number; span: number } | null>(null);
	const builtSpan = builtTape.span;
	// Only while something on the board is still moving. Once every Intent is at rest, "now" is the last event.
	const liveGliding = mode === "live" && runStart !== undefined && !runOver(state.intents);
	useEffect(() => {
		if (!liveGliding || runStart === undefined) {
			return;
		}
		let frame = 0;
		// When "now" needs a wider axis, it widens over a moment rather than in one frame (easeSpan):
		// from the axis shown when the wider one was first wanted, to that one.
		let shown = 0;
		let ease = { from: 0, to: 0, began: 0 };
		const step = (time: number) => {
			if (lead.current !== null) {
				const now = Date.now() + lead.current - runStart;
				const wanted = Math.max(builtSpanRef.current, spanFor(now));
				if (shown === 0 || wanted < shown) {
					ease = { from: wanted, to: wanted, began: time };
				} else if (wanted !== ease.to) {
					ease = { from: shown, to: wanted, began: time };
				}
				shown = easeSpan(ease.from, ease.to, time - ease.began);
				setLiveClock({ start: runStart, now, span: shown });
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [liveGliding, runStart]);
	const builtSpanRef = useRef(builtSpan);
	builtSpanRef.current = builtSpan;
	const tape = useMemo(
		() => (gliding ? advanceTape(builtTape, glide) : liveGliding && liveClock !== null && liveClock.start === runStart ? followClock(builtTape, liveClock.now, liveClock.span) : builtTape),
		[builtTape, gliding, glide, liveGliding, liveClock, runStart],
	);

	// A new recording opens held on the story's first step. Coming back from the Live tab is the same
	// recording started again by the stream (it shows nothing until told where to be), and it goes back
	// to wherever the reader had left it.
	const leftAt = useRef(0);
	useEffect(() => {
		if (mode === "replay" && position > 0) {
			leftAt.current = position;
		}
	}, [mode, position]);
	useEffect(() => {
		const first = story?.steps[0];
		if (first === undefined) {
			return;
		}
		setChase(null);
		setPaused(true);
		seek(leftAt.current > 0 ? leftAt.current : first.at);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [playing, mode]);
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

	const unreachable = control.unreachable && !connected;
	const replayDone = mode === "replay" && recording !== null && events.length >= (FRAME ?? recording.length) && recording.length > 0;
	const loading = mode === "live" ? !connected && events.length === 0 && !unreachable : recording === null;
	const selectedIntent = selected === null ? undefined : state.intents[selected];

	// The Live tab: the sentence for what is on the board.
	const boardAtRest = useMemo(() => runOver(state.intents), [state.intents]);
	// Summed up only once the last events are in. `control.now` ticks each second, so this turns true by itself.
	const liveOver = boardAtRest && runSettled(events, state.intents, control.now);
	// Between pressing Start and the first Intent, the board still shows the run before, or nothing.
	// The Worker's answer is a few seconds old; the log is not. Once the new run's Intents are in the log, it is no
	// longer starting. (Its first event is not enough: a reset logs the numbers at once, before any Intent exists.)
	const ofNewRun = lanes.agents.length + (lanes.workload === null ? 0 : 1) > 0 && events.length > 0 && (events[0] as PremiseEvent).ts >= (control.status?.lastStartAt ?? 0);
	// A start this page asked for counts for a minute whatever a late or stale answer says in between.
	const pressed = control.startedAt !== null && control.now - control.startedAt < 60_000 && !(control.status?.failed ?? false);
	const liveStarting = control.asking || (((control.status?.starting ?? false) || pressed) && !ofNewRun);
	const caption = useMemo(
		() => (liveStory === null ? null : liveCaption(events, liveStory, { unreachable, connecting: loading, starting: liveStarting, over: liveOver, store: control.store, workload: control.status?.workload ?? 30 })),
		[liveStory, events, unreachable, loading, liveStarting, liveOver, control.store, control.status?.workload],
	);
	const liveStatus = useMemo(() => (control.status === null ? null : { ...control.status, starting: control.status.starting && liveStarting }), [control.status, liveStarting]);
	const offer = startOffer(liveStatus, control.now, { asking: control.asking || (pressed && liveStarting), unreachable: control.unreachable, store: control.store });
	// The board coming to rest, or being cleared, is news the last answer does not have.
	const boardEmpty = events.length === 0;
	useEffect(() => {
		if (mode === "live") {
			control.refresh();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode, boardAtRest, boardEmpty, control.refresh]);

	// The Results tab shows the larger run's numbers. That run is a recording of its own, loaded the first
	// time the tab is opened; when it is the one playing (`?demo=scale`), it is already here.
	const [otherRun, setOtherRun] = useState<PremiseEvent[] | null>(null);
	const scaleFromOtherRun = DEMO !== SCALE_RUN && RUNS[`../../demo/runs/${SCALE_RUN}.json`] !== undefined;
	useEffect(() => {
		if (!onResults || !scaleFromOtherRun || otherRun !== null) {
			return;
		}
		let current = true;
		void RUNS[`../../demo/runs/${SCALE_RUN}.json`]?.()
			.then((data) => current && setOtherRun(readRecording(data).events))
			.catch(() => current && setNotice("The larger run could not be loaded. Reload the page to try again."));
		return () => {
			current = false;
		};
	}, [onResults, scaleFromOtherRun, otherRun]);
	const scaleRun = scaleFromOtherRun ? otherRun : DEMO === SCALE_RUN ? recording : null;
	const scaleState = useMemo(() => (scaleRun === null || !onResults ? null : reduceAll(scaleRun)), [scaleRun, onResults]);
	const diff = useIntentDiff(selectedIntent, mode, recordedDiffs, pastRun);

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
			if (tab === "demo" && FRAME === null && !event.metaKey && !event.ctrlKey && !event.altKey && target?.closest("[role=dialog]") == null) {
				// Space on a control reached with the keyboard presses that control, as it does anywhere else.
				if (event.key === " " && target?.matches("button:focus-visible, a:focus-visible, summary:focus-visible, [role=tab]:focus-visible")) {
					return;
				}
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
	}, [lanes.agents, selected, tab, paused, chase, stepIndex, goToStep, playThrough]);

	const show = useCallback((next: Tab) => {
		setSelected(null);
		setChase(null);
		// A replay left playing would go on playing behind the tab that covers it.
		setPaused(true);
		setTab(next);
	}, []);
	const tabs = (
		<Tabs
			// The tab marker is measured when it moves. A new layout moves every tab, so start it afresh.
			key={layout}
			size={layout === "phone" ? "sm" : "base"}
			value={tab}
			onValueChange={(value: string) => show(TABS.find((candidate) => candidate.value === value)?.value ?? "demo")}
			tabs={TABS}
		/>
	);

	// What the bar says is on screen: the kind of run, or that this is one frame of it held still.
	const known = pastRun !== null ? PAST_RUN_KIND : own(RUN_KINDS, DEMO);
	const runKind: RunKind | undefined = onResults
		? { label: "Results · measured on Cloudflare", extra: "scripted agents", detail: "Numbers from runs of the deployed system on real Artifacts: the same work landed under three rules, and one larger recorded run. The agents in them are scripted." }
		: mode === "live"
			? liveKind(control.store)
			: still !== null ? { label: `Still · after event ${still.length}`, extra: known?.label.replace(/^Replay · /, "") ?? "a recorded run", detail: "One moment of the recorded run, held still." } : known;
	const cards = useMemo(() => openCards(state), [state]);
	const figures = useMemo(() => figuresFor(events, state.intents, state.metrics), [events, state.intents, state.metrics]);
	const actions = useMemo<Command[]>(
		() => [
			{ id: "live", title: "Watch the live board", hint: "what the deployed Worker is doing now", run: () => show("live") },
			{ id: "replay", title: "Play the demo recording", hint: "the recorded run, told as a story", run: () => show("demo") },
			{ id: "results", title: "See the results", hint: "the same work under three rules, and a larger run", run: () => show("results") },
			{ id: "dispatch", owner: true, title: "Dispatch tasks", hint: "starts a run; needs the admin token", run: () => setDispatching(true) },
			{ id: "workload", owner: true, title: "Run workload", hint: "scripted Intents; needs the admin token", run: () => setDispatching(true) },
			{
				id: "reset",
				owner: true,
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
			{ id: "github", title: "GitHub repo", hint: "the code, open source", run: () => window.open(GITHUB_URL, "_blank", "noopener,noreferrer") },
			{ id: "shortcuts", title: "Show keyboard shortcuts", keyboardOnly: true, run: () => setShortcutsOpen(true) },
		],
		[token, show],
	);
	// The owner's tools are offered to the owner: with `?admin` in the address, or once the token has been typed in this session.
	const ownerTools = ADMIN || token !== "";
	const offered = useMemo(() => actions.filter((command) => ownerTools || !command.owner), [actions, ownerTools]);
	// The tab that is already on screen is not offered.
	const menuActions = useMemo(() => offered.filter((command) => command.id !== (tab === "demo" ? "replay" : tab)), [offered, tab]);
	const plainMenu = layout !== "wide" || COARSE_POINTER;

	// "Nothing in flight" is a state of the live board. A replay's first seconds, before its first Intent, are not it.
	const empty = mode === "live" && !loading && lanes.agents.length === 0 && lanes.workload === null;
	// A replay's length, and a way to move it to a moment: the tape's time axis is a slider.
	const seekToTime = (ms: number, nudge?: -1 | 1) => {
		const target = positionAt(playing, ms);
		setChase(null);
		// A step must move even when no event falls inside it (the recording has quiet stretches of several seconds).
		seek(nudge === 1 ? Math.max(position + 1, target) : nudge === -1 ? Math.max(1, Math.min(position - 1, target)) : target);
	};
	// The workload's Intents, one line each, while its list is open in the details panel.
	// The details panel slides away when closed: it keeps showing what it showed until it has gone (usePresence).
	const drawer = usePresence(!onResults && (selectedIntent !== undefined || selected === WORKLOAD_LIST) ? selected : null, DRAWER_OUT_MS);
	const drawnIntent = drawer.shown === null || drawer.shown === WORKLOAD_LIST ? undefined : state.intents[drawer.shown];
	const drawnDiff = useRef(diff);
	if (!drawer.leaving) {
		drawnDiff.current = diff;
	}
	const workloadList = drawer.shown === WORKLOAD_LIST ? workloadLines(state.intents, callsignOf) : [];
	const toggleSelected = (id: IntentId) => setSelected((current) => (current === id ? null : id));
	// A card that needs a person sits above the tape: floating over its corner, it would cover "now", the part being watched.
	// Answering one takes the admin token. A visitor to the live board sees the question and not the buttons.
	const humanCards = (
		<HumanCards
			inline
			cards={cards}
			intents={state.intents}
			readOnly={mode === "replay" || token === ""}
			{...(mode === "live" ? { readOnlyNote: "Answering takes the owner's token, so the buttons are off here." } : {})}
			token={token}
			named={named}
			nameOf={callsignOf}
			onNeedToken={() => setDispatching(true)}
		/>
	);
	const storied = story !== null && story.steps.length > 0 && still === null && !onResults;
	return (
		<div className="flex h-full flex-col" style={wide ? { minWidth: 1280 } : undefined}>
			<SimpleBar layout={layout} views={tabs} onMore={() => setPaletteOpen(true)} onHow={openSlides} {...(runKind === undefined ? {} : { kind: runKind })} />
			{/* On a phone the site works, but the timeline is made for a wide screen: say so once, and let it be dismissed. */}
			{layout === "phone" && !phoneNoteGone ? (
				<p className="phone-note" role="note">
					<span>Best viewed on a computer: the timeline is made for a wide screen.</span>
					<button
						type="button"
						className="phone-note-dismiss"
						aria-label="Dismiss this note"
						onClick={() => {
							dismissPhoneNote(browserMemory());
							setPhoneNoteGone(true);
						}}
					>
						Dismiss
					</button>
				</p>
			) : null}
			{storied && story !== null ? (
				<StoryBar steps={story.steps} index={stepIndex} playing={!paused && chase === null} moving={chase !== null} onStep={goToStep} onPlay={playThrough} onPause={() => setPaused(true)} onRestart={() => goToStep(0)} />
			) : null}
			{mode === "live" && caption !== null ? <LiveBar caption={caption} offer={offer} connected={connected} onStart={control.start} /> : null}
			{(storied || (mode === "live" && lanes.agents.length > 0)) && layout !== "phone" ? <RunFigures figures={figures} ended={mode === "live" ? liveOver : replayDone} /> : null}
			{notice ? (
				<div role="status" className="flex items-center justify-between" style={{ padding: "6px 16px", background: "var(--surface)", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
					{notice}
					<Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
						Dismiss
					</Button>
				</div>
			) : null}
			{/* The space above the board is outside the part that scrolls, so it is still there when the tape's header has stuck to the top. */}
			<div className="flex min-h-0 flex-1" style={{ paddingTop: 12 }}>
				<main className="min-w-0 flex-1 overflow-auto" style={{ padding: wide ? "0 24px 8px" : "0 12px 8px" }} aria-label={onResults ? "Results" : mode === "live" ? "The live board" : "The recorded run"}>
					{onResults ? null : humanCards}
					{onResults ? (
						<div className="results">
							<RecentRuns onWatch={() => show("live")} owner={ownerTools} token={token} onNeedToken={() => setDispatching(true)} />
							<AbPanel results={AB_RESULTS} />
							{scaleRun === null || scaleState === null ? (
								scaleFromOtherRun || DEMO === SCALE_RUN ? <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading the larger run…</p> : null
							) : (
								<ScaleView events={scaleRun} metrics={scaleState.metrics} intents={scaleState.intents} {...(scaleFromOtherRun ? { otherRun: { name: SCALE_RUN, href: `/?demo=${SCALE_RUN}` } } : {})} />
							)}
						</div>
					) : loading ? (
						// The tape's own shape, across the whole width, so nothing jumps when the run arrives.
						<section className="tape bracketed tape-loading" data-layout={layout} data-density={layout === "phone" ? "compact" : "medium"} aria-label={mode === "live" ? "Connecting to the live board" : "Loading the run"} aria-busy="true">
							<div className="tape-rows">
								{Array.from({ length: mode === "live" ? 8 : 4 }, (_, index) => (
									<div key={index} className="tape-row">
										<span className="tape-label">
											<SkeletonLine />
										</span>
										<span className="tape-trackwrap">
											{/* Bars of different lengths, like a run part of the way through. */}
											<span className="tape-loading-bar" style={{ width: `${28 + ((index * 23) % 44)}%`, animationDelay: `${index * 90}ms` }} />
										</span>
									</div>
								))}
							</div>
						</section>
					) : empty ? (
						// The sentence above says what to do. This only says the tape is not missing: there is nothing to draw yet.
						<p className="live-empty label">{unreachable ? "No Worker to show a board for" : liveStarting ? "The board is being cleared" : "No Intents on the board"}</p>
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
							{...(mode === "live" && caption?.step !== undefined && caption.id !== "end" ? { step: caption.step } : {})}
							{...((story ?? liveStory) !== null ? { notes: (story ?? liveStory)?.notes ?? {} } : {})}
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
					onStarted={() => show("live")}
				/>
			) : null}
			{/* A keyboard gets the palette (⌘K). A touch screen, or a narrow window, gets the same actions as buttons. */}
			{plainMenu ? <MoreSheet open={paletteOpen} onOpenChange={setPaletteOpen} actions={menuActions} /> : <Palette open={paletteOpen} onOpenChange={setPaletteOpen} actions={offered} />}
			<Shortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
			{slidesCard && tab === "demo" && !slidesOpen ? <SlidesCard onOpen={openSlides} onDismiss={() => setSlidesCard(false)} /> : null}
			{slidesOpen ? <SlidesOverlay onClose={closeSlides} /> : null}
			{drawer.shown !== null && (drawnIntent !== undefined || drawer.shown === WORKLOAD_LIST) ? <Drawer intent={drawnIntent} leaving={drawer.leaving} {...(drawer.shown === WORKLOAD_LIST ? { listing: { title: "Workload", sentence: `${workloadList.length} scripted Intents: small pre-written edits, with no agent and no model. Each goes through the ledger and the gate like an agent's work. Click one for its details.`, content: <WorkloadList lines={workloadList} onSelect={setSelected} /> } } : {})} {...(drawnIntent?.kind === "workload" ? { onBack: () => setSelected(WORKLOAD_LIST) } : {})} events={events} callsignOf={callsignOf} named={named} diff={drawnDiff.current} changesFrom={mode === "live" ? "live" : pastRun !== null ? "past-run" : "recording"} layout={layout} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
		</div>
	);
}
