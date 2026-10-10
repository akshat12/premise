import { Button, Empty, SkeletonLine, Tabs } from "@cloudflare/kumo";
import { ArrowCounterClockwise, AirplaneTakeoff } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PremiseEvent } from "../shared/events";
import type { IntentId, SymbolId } from "../shared/types";
import { Drawer } from "./components/Drawer";
import { Lanes } from "./components/Lanes";
import { LedgerRail } from "./components/LedgerRail";
import { type LiveState, TopBar } from "./components/TopBar";
import { type StreamSource, useEventStream } from "./lib/useEventStream";
import { useViewState } from "./lib/useViewState";
import { sharedSymbols } from "./lib/chips";
import { callsign, lanesOf, ledgerRows, OUTSIDE } from "./lib/view";

const LIVE_URL = "/api/events/ws";
const SPEEDS = [1, 2, 4, 8];
type Mode = "replay" | "live";

const query = new URLSearchParams(window.location.search);
/** `?live` opens on the live stream; otherwise the recorded run plays, which needs no backend. */
const startMode = (): Mode => (query.has("live") ? "live" : "replay");
/** `?frame=420` shows the recording as it stood after its first 420 events and stops there: a still, for screenshots and for pointing at one moment. */
const FRAME = query.has("frame") ? Math.max(0, Number(query.get("frame")) || 0) : null;

export function App() {
	const [mode, setMode] = useState<Mode>(startMode);
	const [speed, setSpeed] = useState(2);
	const [run, setRun] = useState(0);
	const [recording, setRecording] = useState<PremiseEvent[] | null>(null);
	const [selected, setSelected] = useState<IntentId | null>(null);
	const [hoverSymbol, setHoverSymbol] = useState<SymbolId | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const onResize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	// The board is what is left of the window after the ledger rail (320) and the board's own padding (32).
	// 16 more for a scrollbar, which appears when the drawer is open.
	const boardWidth = Math.max(1280, windowWidth) - 320 - 32 - 16;

	// The recording is a real run of the deployed system. It is loaded on demand, not bundled into the first paint.
	useEffect(() => {
		let current = true;
		void import("./fixtures/real-run.json").then((module) => current && setRecording(module.default as PremiseEvent[]));
		return () => {
			current = false;
		};
	}, []);

	const source = useMemo<StreamSource>(
		// `run` is in the list so that "Play again" restarts the same recording.
		() => (mode === "live" ? { kind: "live", url: LIVE_URL } : { kind: "replay", events: recording && FRAME === null ? [...recording] : [], speed }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[mode, recording, speed, run],
	);
	const stream = useEventStream(source);
	// A still frame is the recording cut at that point, shown at once, with nothing playing.
	const still = useMemo(() => (FRAME !== null && recording && mode === "replay" ? recording.slice(0, FRAME) : null), [recording, mode]);
	const events = still ?? stream.events;
	const connected = stream.connected;
	const view = useViewState(events);
	const lanes = useMemo(() => lanesOf(view), [view]);
	const rows = useMemo(() => ledgerRows(view), [view]);
	const shared = useMemo(() => sharedSymbols(view), [view]);
	const callsignOf = useCallback(
		(id: IntentId) => {
			const intent = view.intents[id];
			return intent ? callsign(intent) : id === OUTSIDE ? "a push to trunk" : id;
		},
		[view.intents],
	);

	// Messages from the backend name Intents by id. On screen they go by callsign.
	const named = useCallback(
		(text: string) => text.replace(/\bi[0-9a-z]{8}\b/g, (id) => (view.intents[id] ? callsign(view.intents[id] as (typeof view.intents)[string]) : id)).replace(/\bintent (T\d+ )/g, "$1"),
		[view.intents],
	);

	const replayDone = mode === "replay" && recording !== null && events.length >= (FRAME ?? recording.length) && recording.length > 0;
	const live: LiveState = mode === "live" ? (connected ? { kind: "live" } : { kind: "reconnecting" }) : still !== null ? { kind: "still", at: still.length } : { kind: "replay", speed, done: replayDone };
	const loading = mode === "live" ? !connected && events.length === 0 : recording === null;
	const selectedIntent = selected === null ? undefined : view.intents[selected];

	// j / k move between strips, Enter opens the drawer, Esc closes it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
				return;
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
	}, [lanes.agents, selected]);

	const controls = (
		<div className="flex items-center gap-2">
			<Tabs
				size="sm"
				value={mode}
				onValueChange={(value: string) => {
					setSelected(null);
					setMode(value === "live" ? "live" : "replay");
				}}
				tabs={[
					{ value: "replay", label: "Replay" },
					{ value: "live", label: "Live" },
				]}
			/>
			{mode === "replay" ? (
				<>
					<Tabs size="sm" value={String(speed)} onValueChange={(value: string) => setSpeed(Number(value))} tabs={SPEEDS.map((value) => ({ value: String(value), label: `${value}×` }))} />
					<Button variant="ghost" size="sm" shape="square" aria-label="Play again" title="Play the recording again from the start" onClick={() => setRun((count) => count + 1)}>
						<ArrowCounterClockwise size={16} />
					</Button>
				</>
			) : null}
		</div>
	);

	const empty = !loading && lanes.agents.length === 0 && lanes.workload === null;
	return (
		<div className="flex h-full flex-col" style={{ minWidth: 1280 }}>
			<TopBar metrics={view.metrics} trunk={view.trunk.commit} live={live} marker={view.markers.at(-1)} controls={controls} onDispatch={() => setNotice("Dispatching from here arrives with the dispatch panel. For now, start a run from the command line.")} />
			{notice ? (
				<div role="status" className="flex items-center justify-between" style={{ padding: "6px 16px", background: "#fff", borderBottom: "1px solid var(--rule)", fontSize: 13 }}>
					{notice}
					<Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
						Dismiss
					</Button>
				</div>
			) : null}
			<div className="flex min-h-0 flex-1">
				<main className="min-w-0 flex-1 overflow-auto" style={{ padding: "8px 16px" }} aria-label="Strip board">
					{loading ? (
						<div className="flex flex-col gap-2" aria-label="Loading the run">
							{Array.from({ length: 8 }, (_, index) => (
								<div key={index} className="strip" style={{ width: 480, gridTemplateColumns: "6px 1fr", alignItems: "center" }}>
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
								<Button variant="primary" onClick={() => setNotice("Dispatching from here arrives with the dispatch panel. For now, start a run from the command line.")}>
									Dispatch tasks
								</Button>
							}
						/>
					) : (
						<Lanes lanes={lanes} width={boardWidth} shared={shared} selected={selected} hoverSymbol={hoverSymbol} onSelect={(id) => setSelected((current) => (current === id ? null : id))} onHoverSymbol={setHoverSymbol} />
					)}
				</main>
				<LedgerRail rows={rows} quiet={!empty && !loading} callsignOf={callsignOf} hoverSymbol={hoverSymbol} onHoverSymbol={setHoverSymbol} />
			</div>
			{selectedIntent ? <Drawer intent={selectedIntent} events={events} callsignOf={callsignOf} named={named} onSelect={setSelected} onClose={() => setSelected(null)} /> : null}
		</div>
	);
}
