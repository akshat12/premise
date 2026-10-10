import type { PremiseEvent, PremiseEventBody } from "../../shared/events";
import type { Metrics } from "../../shared/types";
import type { RegistryRow } from "../metrics";

type HubEnv = Pick<Env, "HUB">;

/** "premise" is the product; "baseline" is what it is compared with in the A/B report (see ab/run.ts). */
export type RunMode = "premise" | "baseline";

/**
 * The EventHub's RPC surface. Declared by hand because the generated stub type maps the array
 * returns to `never`: the event union contains `Record<string, unknown>` (the `artifacts` event's
 * `detail`), which the Workers RPC type helpers do not accept as serialisable.
 */
export interface HubApi {
	publish(body: PremiseEventBody): Promise<PremiseEvent>;
	publishMany(bodies: PremiseEventBody[]): Promise<PremiseEvent[]>;
	since(seq: number, limit?: number): Promise<PremiseEvent[]>;
	reset(): Promise<void>;
	registry(): Promise<RegistryRow[]>;
	asserters(): Promise<string[]>;
	claimCommit(commit: string): Promise<boolean>;
	isProcessed(commit: string): Promise<boolean>;
	shards(): Promise<string[]>;
	metrics(): Promise<Metrics>;
	bump(counter: "brokenBuildsOnTrunk" | "behaviouralRegressionsOnTrunk" | "humanMerges", by?: number): Promise<void>;
	trunk(): Promise<string | null>;
	setTrunk(name: string): Promise<void>;
	mode(): Promise<RunMode>;
	setMode(mode: RunMode): Promise<void>;
	llm(): Promise<{ provider: string; model?: string } | null>;
	setLlm(choice: { provider: string; model?: string } | null): Promise<void>;
	addWaiter(instanceId: string, topic: string): Promise<void>;
	takeWaiters(topic: string): Promise<string[]>;
	fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

/** The single EventHub instance. `name` is only overridden in tests. */
export function hub(env: HubEnv, name = "main"): HubApi {
	return env.HUB.get(env.HUB.idFromName(name)) as unknown as HubApi;
}

/** Publish one event. All backend code publishes through here. */
export async function publish(env: HubEnv, body: PremiseEventBody): Promise<PremiseEvent> {
	return hub(env).publish(body);
}

/** Publish a batch in order, in one call to the hub. */
export async function publishMany(env: HubEnv, bodies: PremiseEventBody[]): Promise<PremiseEvent[]> {
	return bodies.length === 0 ? [] : hub(env).publishMany(bodies);
}

/** Publishes the current metrics as a `metrics` event. Call after anything that changes a counter the UI shows. */
export async function publishMetrics(env: HubEnv): Promise<PremiseEvent> {
	const target = hub(env);
	return target.publish({ t: "metrics", metrics: await target.metrics() });
}

/**
 * The repo acting as trunk. It starts as TRUNK_REPO and changes when the demo is reset, which
 * imports a fresh copy under a new name. Read the name through here, never from `env` directly.
 */
export async function currentTrunk(env: HubEnv & Pick<Env, "TRUNK_REPO">): Promise<string> {
	return (await hub(env).trunk()) ?? env.TRUNK_REPO;
}

/** How work lands right now. Anything other than an explicit "baseline" is the product itself. */
export async function currentMode(env: HubEnv): Promise<RunMode> {
	return (await hub(env).mode().catch(() => "premise" as const)) === "baseline" ? "baseline" : "premise";
}

/**
 * The environment with the run-time choice of model provider applied (see `hub.llm()`), so the
 * same deployed Worker can replay recorded agents for one run and use a real model for the next.
 */
export async function withChosenLlm<E extends HubEnv & { LLM?: string; LLM_MODEL?: string }>(env: E): Promise<E> {
	const choice = await hub(env).llm().catch(() => null);
	return choice === null ? env : { ...env, LLM: choice.provider, ...(choice.model === undefined ? {} : { LLM_MODEL: choice.model }) };
}

/** Topic names for paused Workflow instances. */
export const waitTopic = {
	/** Waiting for this Intent to land or fail, so its claims are released. */
	ledger: (intentId: string) => `ledger:${intentId}`,
	/** Waiting for a person to choose what happens to this Intent. */
	human: (intentId: string) => `human:${intentId}`,
};
