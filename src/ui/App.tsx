import { Button, Flow } from "@cloudflare/kumo";
import { useMemo, useState } from "react";
import { reduceAll } from "./lib/reduce";
import { type StreamSource, useEventStream } from "./lib/useEventStream";

// Smoke render only (T01, T04): proves Kumo, Tailwind, the Worker API and the live event stream are wired up.
// T20 replaces this with the real shell.
const LIVE: StreamSource = { kind: "live", url: "/api/events/ws" };

export function App() {
	const [health, setHealth] = useState<string>("not checked");
	const { events, connected } = useEventStream(LIVE);
	const view = useMemo(() => reduceAll(events), [events]);

	async function checkHealth() {
		const response = await fetch("/api/health");
		setHealth(JSON.stringify(await response.json()));
	}

	return (
		<main className="flex min-h-screen flex-col gap-6 p-8">
			<h1 className="text-2xl font-semibold">Premise</h1>
			<div className="flex items-center gap-4">
				<Button variant="primary" onClick={checkHealth}>
					Check health
				</Button>
				<code data-testid="health">{health}</code>
			</div>
			<p data-testid="stream">
				Event stream: {connected ? "connected" : "disconnected"} · {events.length} events · {Object.keys(view.intents).length} Intents ·{" "}
				{view.markers.at(-1) ?? "no markers"}
			</p>
			<Flow canvas={false}>
				<Flow.Node>Intent</Flow.Node>
				<Flow.Node>Gate</Flow.Node>
				<Flow.Node>Trunk</Flow.Node>
			</Flow>
		</main>
	);
}
