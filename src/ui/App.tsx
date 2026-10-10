import { Button, Empty, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { ArrowCounterClockwise, AirplaneTakeoff, Pause, Play } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PremiseEvent } from "../shared/events";
import type { IntentId, SymbolId } from "../shared/types";
import { AbPanel, type AbResults } from "./components/AbPanel";
import { DispatchPanel } from "./components/DispatchPanel";
import { Drawer } from "./components/Drawer";
import { HumanCards } from "./components/HumanCards";
import { CompactLanes, Lanes } from "./components/Lanes";
import { BuiltOn, LedgerRail } from "./components/LedgerRail";
import { type Command, Palette, Shortcuts } from "./components/Palette";
import { ScaleView } from "./components/ScaleView";
import { type LiveState, TopBar } from "./components/TopBar";
import { type StreamSource, useEventStream } from "./lib/useEventStream";
import { useViewState } from "./lib/useViewState";
import { explain, loadToken, resetDemo, saveToken } from "./lib/api";
import { openCards, sharedSymbols } from "./lib/chips";
import { nextStop } from "./lib/demo";
import { callsign, lanesOf, layoutFor, ledgerRows, OUTSIDE } from "./lib/view";

const LIVE_URL = "/api/events/ws";
const SPEEDS = [1, 2, 4, 8];
type Mode = "replay" | "live";
type View = "lanes" | "ledger" | "scale" | "ab";
const VIEWS: { value: View; label: string }[] = [
	{ value: "lanes", label: "Lanes" },
	// On a wide screen the ledger is the rail beside the lanes. On a narrow one it is a view of its own.
	{ value: "ledger", label: "Ledger" },
	{ value: "scale", label: "Scale" },
	{ value: "ab", label: "A/B" },
];
const VIEW_LABEL: Record<View, string> = { lanes: "Strip board", ledger: "Ledger", scale: "Scale", ab: "A/B results" };
/** How long a "⏩ compressed" marker stays in the top bar. */
const MARKER_MS = 3000;

const query = new URLSearchParams(window.location.search);
/** `?live` opens on the live stream; otherwise the recorded run plays, which needs no backend. */
const startMode = (): Mode => (query.has("live") ? "live" : "replay");
/** `?frame=420` shows the recording as it stood after its first 420 events and stops there: a still, for screenshots and for pointing at one moment. */
const FRAME = query.has("frame") ? Math.max(0, Number(query.get("frame")) || 0) : null;
/** `?demo=main` plays demo/runs/main.json, a recorded run with its idle time cut out, at 1×. */
const DEMO = query.get("demo");

// Recorded runs are bundled, each as a chunk of its own that is fetched only when it is asked for.
const RUNS = import.meta.glob<PremiseEvent[]>("../../demo/runs/*.json", { import: "default" });
const BUILT_IN = () => import("./fixtures/real-run.json").then((module) => module.default as PremiseEvent[]);
const AB_RESULTS: AbResults | null = Object.values(import.meta.glob<AbResults>("../../docs/ab-results.json", { import: "default", eager: true }))[0] ?? null;

export function App() {
	const [mode, setMode] = useState<Mode>(startMode);
	const [view, setView] = useState<View>("lanes");
	const [speed, setSpeed] = useState(DEMO === null ? 2 : 1);
	const [paused, setPaused] = useState(false);
	const [marker, setMarker] = useState<string | undefined>(undefined);
	const [run, setRun] = useState(0);
	const [recording, setRecording] = useState<PremiseEvent[] | null>(null);
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
		const chosen = DEMO === null ? undefined : RUNS[`../../demo/runs/${DEMO}.json`];
		if (DEMO !== null && chosen === undefined) {
			setNotice(`There is no recorded run called "${DEMO}". Playing the built-in recording.`);
		}
		void (chosen ?? BUILT_IN)().then((events) => current && setRecording(events));
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
			document.querySelector<HTMLElement>(`[data-node-id="strip-${ids[next]}"] .strip-open`)?.focus();
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
			{ id: "scale", title: "Show the scale view", run: () => setView("scale") },
			{ id: "ab", title: "Show the A/B results", run: () => setView("ab") },
			{ id: "shortcuts", title: "Show keyboard shortcuts", run: () => setShortcutsOpen(true) },
		],
		[token],
	);
	const jumpTo = useCallback((id: IntentId) => {
		setView("lanes");
		setSelected(id);
	}, []);
	const jumps = useMemo<Command[]>(() => lanes.agents.map((intent) => ({ id: `jump-${intent.id}`, title: `Jump to ${callsign(intent)}`, run: () => jumpTo(intent.id) })), [lanes.agents, jumpTo]);

	const empty = !loading && lanes.agents.length === 0 && lanes.workload === null;
	const toggleSelected = (id: IntentId) => setSelected((current) => (current === id ? null : id));
	const humanCards = <HumanCards inline={!wide} cards={cards} intents={state.intents} readOnly={mode === "replay"} token={token} named={named} onNeedToken={() => setDispatching(true)} />;
	return (
		<div className="flex h-full flex-col" style={wide ? { minWidth: 1280 } : undefined}>
			<TopBar
				metrics={state.metrics}
				trunk={state.trunk.commit}
				live={live}
				marker={marker}
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
				onDispatch={() => setDispatching(true)}
			/>
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
					{!wide && view === "lanes" ? humanCards : null}
					{view === "ab" ? (
						<AbPanel results={AB_RESULTS} />
					) : view === "scale" ? (
						<ScaleView events={events} metrics={state.metrics} intents={state.intents} />
					) : view === "ledger" ? (
						<LedgerRail fill rows={rows} quiet={!empty && !loading} callsignOf={callsignOf} hoverSymbol={hoverSymbol} onHoverSymbol={setHoverSymbol} />
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
				{wide && view === "lanes" ? <LedgerRail rows={rows} quiet={!empty && !loading} callsignOf={callsignOf} hoverSymbol={hoverSymbol} onHoverSymbol={setHoverSymbol} /> : null}
			</div>
			{wide ? humanCards : null}
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
			{selectedIntent && view === "lanes" ? <Drawer intent={selectedIntent} events={events} callsignOf={callsignOf} named={named} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
		</div>
	);
}
