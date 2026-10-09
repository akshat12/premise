import { Button, Flow } from "@cloudflare/kumo";
import { useState } from "react";

// T01 smoke render only: proves Kumo, Tailwind and the Worker API are wired up.
export function App() {
	const [health, setHealth] = useState<string>("not checked");

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
			<Flow canvas={false}>
				<Flow.Node>Intent</Flow.Node>
				<Flow.Node>Gate</Flow.Node>
				<Flow.Node>Trunk</Flow.Node>
			</Flow>
		</main>
	);
}
