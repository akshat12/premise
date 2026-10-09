import type { PremiseEvent, PremiseEventBody } from "../../shared/events";

type HubEnv = Pick<Env, "HUB">;

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
