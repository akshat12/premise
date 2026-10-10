// How the rest of the backend reaches an Intent's Durable Object.
import type { Claim, CommitSha, Intent, IntentId, Premise, SymbolId } from "../../shared/types";
import type { FileChanges } from "../ports/repo-store";
import { type Reviver, rpcClient } from "../rpc";
import { IllegalTransition, type IntentAction } from "./machine";
import type { BreakScope, BrokenBy } from "./premises";

/** The IntentDO RPC surface, declared by hand so callers do not depend on generated stub types. */
export interface IntentApi {
	init(intent: Intent): Promise<Intent>;
	get(): Promise<Intent>;
	act(action: IntentAction, note?: string): Promise<Intent>;
	recordPremise(premise: Premise): Promise<Intent>;
	recordPremises(premises: Premise[]): Promise<Intent>;
	breakPremise(symbol: SymbolId, by: BrokenBy, scope?: BreakScope): Promise<{ broken: boolean; intent: Intent }>;
	setClaims(claims: Claim[]): Promise<Intent>;
	setWhy(lines: string[]): Promise<Intent>;
	addRejected(alternative: string): Promise<Intent>;
	setDependsOn(dependsOn: IntentId[]): Promise<Intent>;
	setHead(commit: CommitSha): Promise<Intent>;
	incRederive(): Promise<Intent>;
	restartOn(repo: string, baseCommit: CommitSha): Promise<Intent>;
	writeOverlay(path: string, content: string | null): Promise<void>;
	readOverlay(path: string): Promise<string | null | undefined>;
	overlay(): Promise<FileChanges>;
	clearOverlay(): Promise<void>;
}

/** Every operation in IntentApi. The Durable Object refuses any name that is not in this list. */
export const INTENT_METHODS = [
	"init",
	"get",
	"act",
	"recordPremise",
	"recordPremises",
	"breakPremise",
	"setClaims",
	"setWhy",
	"addRejected",
	"setDependsOn",
	"setHead",
	"incRederive",
	"restartOn",
	"writeOverlay",
	"readOverlay",
	"overlay",
	"clearOverlay",
] as const satisfies readonly (keyof IntentApi)[];

// Fails to compile if IntentApi gains a method that is missing from the list above.
type Unlisted = Exclude<keyof IntentApi, (typeof INTENT_METHODS)[number]>;
const _complete: Unlisted extends never ? true : never = true;
void _complete;

const revive: Reviver = (error) => {
	if (error.name === "IllegalTransition") {
		return new IllegalTransition(error.data.from as IllegalTransition["from"], error.data.action as IllegalTransition["action"]);
	}
	return undefined;
};

/** The client for one Intent. Errors thrown inside the Durable Object are re-thrown here, with their class. */
export function intentStub(env: Pick<Env, "INTENT">, id: IntentId): IntentApi {
	return rpcClient<IntentApi>(env.INTENT.get(env.INTENT.idFromName(id)), INTENT_METHODS, revive);
}

/** A new Intent record in its starting state. */
export function newIntent(fields: Pick<Intent, "id" | "kind" | "taskId" | "goal" | "acceptance" | "baseCommit"> & Partial<Intent>, now: number = Date.now()): Intent {
	return {
		claims: [],
		premises: [],
		rejectedAlternatives: [],
		why: [],
		repo: fields.id,
		headCommit: null,
		status: "planning",
		rederiveAttempts: 0,
		dependsOn: [],
		createdAt: now,
		updatedAt: now,
		...fields,
	};
}
