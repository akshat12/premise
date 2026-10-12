import { Button, Checkbox, Input } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { TaskDef } from "../../shared/types";
import { dispatch, explain, fetchTasks, LAND_FIRST, resetDemo } from "../lib/api";

interface DispatchPanelProps {
	token: string;
	onToken: (token: string) => void;
	onClose: () => void;
	/** Called after something was started, so the app can switch to the live stream. */
	onStarted: () => void;
}

const callsignOf = (task: TaskDef) => (/^(t\d+)-([a-z0-9]+)/i.exec(task.id)?.slice(1).join(" ") ?? task.id).toUpperCase();
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(Number.isFinite(value) ? value : low)));

/** The slide-over where a person starts work: which tasks, how much scripted workload, and go. */
export function DispatchPanel({ token, onToken, onClose, onStarted }: DispatchPanelProps) {
	const [tasks, setTasks] = useState<TaskDef[] | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [landFirst, setLandFirst] = useState(true);
	const [workload, setWorkload] = useState(0);
	const [seed, setSeed] = useState(7);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

	useEffect(() => {
		let current = true;
		fetchTasks().then(
			(loaded) => {
				if (current) {
					setTasks(loaded);
					setChosen(new Set(loaded.map((task) => task.id)));
				}
			},
			(error: unknown) => current && setMessage({ text: explain(error), bad: true }),
		);
		return () => {
			current = false;
		};
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	async function run(action: () => Promise<string>) {
		if (token.trim() === "") {
			setMessage({ text: "Enter the admin token first.", bad: true });
			return;
		}
		setBusy(true);
		setMessage(null);
		try {
			setMessage({ text: await action(), bad: false });
			onStarted();
		} catch (error) {
			setMessage({ text: explain(error), bad: true });
		} finally {
			setBusy(false);
		}
	}

	const toggle = (id: string) =>
		setChosen((current) => {
			const next = new Set(current);
			if (!next.delete(id)) {
				next.add(id);
			}
			return next;
		});

	return (
		<>
			<button type="button" aria-label="Close the dispatch panel" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 29, background: "rgba(23, 32, 43, 0.25)", border: 0 }} />
			<aside role="dialog" aria-modal="true" aria-label="Dispatch tasks" className="drawer-left flex flex-col" style={{ position: "fixed", top: 0, bottom: 0, left: 0, width: "min(420px, 100vw)", zIndex: 30, background: "#fff", borderRight: "1px solid var(--rule)" }}>
				<header className="flex items-center justify-between" style={{ padding: "14px 20px", borderBottom: "1px solid var(--rule)" }}>
					<h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Dispatch tasks</h2>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
				</header>
				<div className="flex-1 overflow-y-auto" style={{ padding: "16px 20px" }}>
					<Input label="Admin token" description="Kept for this browser session only." type="password" size="sm" value={token} onChange={(event: React.ChangeEvent<HTMLInputElement>) => onToken(event.target.value)} autoComplete="off" />
					<div className="flex items-center justify-between" style={{ margin: "20px 0 6px" }}>
						<h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Tasks</h3>
						{tasks ? (
							<Button variant="ghost" size="xs" onClick={() => setChosen(chosen.size === tasks.length ? new Set() : new Set(tasks.map((task) => task.id)))}>
								{chosen.size === tasks.length ? "Clear all" : "Select all"}
							</Button>
						) : null}
					</div>
					{tasks === null ? <p style={{ fontSize: 13, color: "var(--ink-soft)" }}>Loading the task list…</p> : null}
					<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
						{(tasks ?? []).map((task) => (
							<li key={task.id} style={{ padding: "5px 0", borderBottom: "1px solid var(--rule)" }}>
								<Checkbox
									checked={chosen.has(task.id)}
									onCheckedChange={() => toggle(task.id)}
									label={
										<span>
											<span className="callsign" style={{ fontSize: 12, marginRight: 8 }}>
												{callsignOf(task)}
											</span>
											<span style={{ fontSize: 13 }}>{task.title}</span>
										</span>
									}
								/>
							</li>
						))}
					</ul>
					<div style={{ marginTop: 12 }}>
						<Checkbox checked={landFirst} onCheckedChange={(value: boolean) => setLandFirst(value)} label="Land T01 first, while the others are in flight" disabled={!chosen.has(LAND_FIRST)} />
						<p style={{ margin: "2px 0 0 26px", fontSize: 12, color: "var(--ink-soft)" }}>This only orders the landings. Without it, whichever agent finishes first lands first.</p>
					</div>
					<h3 style={{ margin: "20px 0 6px", fontSize: 13, fontWeight: 600 }}>Scripted workload</h3>
					<div className="flex gap-3">
						<Input label="Workload Intents (0–500)" type="number" size="sm" min={0} max={500} value={String(workload)} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setWorkload(clamp(Number(event.target.value), 0, 500))} />
						<Input label="Seed" type="number" size="sm" value={String(seed)} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSeed(clamp(Number(event.target.value), 0, 1_000_000))} />
					</div>
					<p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--ink-soft)" }}>Scripted edits, not a model. They take real forks and go through the same gate.</p>
				</div>
				<footer style={{ padding: "12px 20px", borderTop: "1px solid var(--rule)" }}>
					{message ? (
						<p role={message.bad ? "alert" : "status"} style={{ margin: "0 0 8px", fontSize: 13, color: message.bad ? "var(--redpen)" : "var(--holds)" }}>
							{message.text}
						</p>
					) : null}
					<div className="flex items-center justify-between gap-3">
						<Button variant="secondary-destructive" size="sm" disabled={busy} onClick={() => void run(async () => `Reset. Trunk is now ${(await resetDemo(token)).trunk}.`)}>
							Reset demo
						</Button>
						<Button variant="primary" disabled={busy || (chosen.size === 0 && workload === 0)} onClick={() => void run(() => dispatch({ taskIds: (tasks ?? []).map((task) => task.id).filter((id) => chosen.has(id)), landFirst, workload, seed }, token))}>
							{busy ? "Starting…" : `Dispatch ${chosen.size} task${chosen.size === 1 ? "" : "s"}${workload > 0 ? ` and ${workload} workload` : ""}`}
						</Button>
					</div>
				</footer>
			</aside>
		</>
	);
}
