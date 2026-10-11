// Who may be asked about. The public routes take an Intent id from anyone, and asking a Durable
// Object namespace for an id creates the object: so an id is checked before it gets that far.
import type { IntentId } from "../../shared/types";
import { hub } from "../hub/publish";

/** The shape `newIntentId()` makes (src/shared/ids.ts): "i" and eight lowercase base-36 characters. */
const INTENT_ID = /^i[0-9a-z]{8}$/;

export function isIntentId(value: string): value is IntentId {
	return INTENT_ID.test(value);
}

/**
 * Splits "/api/intents/<id>" or "/api/intents/<id>/<rest>" into its parts. The id is returned as
 * it was sent, undecoded: a real one has nothing to decode. null for any other path.
 */
export function parseIntentPath(pathname: string): { id: string; rest: string } | null {
	const match = /^\/api\/intents\/([^/]+)(?:\/(.*))?$/.exec(pathname);
	return match ? { id: match[1] as string, rest: match[2] ?? "" } : null;
}

/**
 * True for the id of an Intent that exists: it has the right shape and the EventHub's registry
 * lists it. Nothing is created by asking, whatever the id.
 */
export async function isKnownIntent(env: Pick<Env, "HUB">, id: string): Promise<boolean> {
	return isIntentId(id) && (await hub(env).knows(id));
}
