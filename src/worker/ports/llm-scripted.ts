import type { LlmClient, LlmMessage, LlmTurn, ToolDef } from "./llm";

/** Replays recorded turns in order. For tests, local dev without keys, and the stage-demo fallback. */
export class ScriptedLlm implements LlmClient {
	private next = 0;

	constructor(
		private readonly turns: readonly LlmTurn[],
		private readonly label?: string,
	) {}

	async turn(_system: string, _messages: LlmMessage[], _tools: ToolDef[]): Promise<LlmTurn> {
		const turn = this.turns[this.next];
		if (turn === undefined) {
			const which = this.label === undefined ? "the script" : `script "${this.label}"`;
			throw new Error(this.turns.length === 0 ? `ScriptedLlm has no turns for ${which}` : `ScriptedLlm ran out of turns: ${which} has ${this.turns.length} and turn ${this.next + 1} was requested`);
		}
		this.next++;
		// A copy, so a caller that edits what it received cannot change the script.
		return structuredClone(turn);
	}

	get remaining(): number {
		return this.turns.length - this.next;
	}
}

/** Wraps a real client and appends every turn it returns to `sink`, so a live run can be replayed later. */
export class RecordingLlm implements LlmClient {
	constructor(
		private readonly inner: LlmClient,
		private readonly sink: LlmTurn[],
	) {}

	async turn(system: string, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmTurn> {
		const turn = await this.inner.turn(system, messages, tools);
		// Scripts replay through ScriptedLlm, which never sends anything back to a provider, so the
		// provider's opaque payload is not worth storing.
		const { raw: _raw, ...recorded } = turn;
		this.sink.push(structuredClone(recorded));
		return turn;
	}
}
