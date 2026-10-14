// The scripted workload, one line per Intent: what the Workload row on the board opens. Pure.
import type { IntentId, IntentStatus } from "../../shared/types";
import type { IntentView } from "./reduce";
import { symbolName } from "./view";

/** What `selected` holds when the Workload row's list is open rather than one Intent. Never an Intent id. */
export const WORKLOAD_LIST = "workload-list" as IntentId;

export interface WorkloadLine {
	id: IntentId;
	/** Its tag, "w7_11". */
	name: string;
	/** What the edit does, without the tag: "touch the body of planPrice". */
	edit: string;
	status: IntentStatus;
	/** Where it is, in a word or two. */
	state: "landed" | "did not land" | "stopped" | "in flight" | "needs a person";
	/** Why it did not land, in words, when it did not. */
	reason: string | null;
}

const STATE: Record<IntentStatus, WorkloadLine["state"]> = {
	planning: "in flight",
	claiming: "in flight",
	waiting: "in flight",
	working: "in flight",
	submitted: "in flight",
	checking: "in flight",
	queued: "in flight",
	gating: "in flight",
	stale: "stopped",
	rederiving: "stopped",
	landed: "landed",
	failed: "did not land",
	escalated: "needs a person",
	quarantined: "stopped",
};

/**
 * Why a workload Intent ended, from the note on its last status change. The common one, a claim
 * the ledger kept saying Wait to, is put in plain words with the other Intent's name; anything
 * else is the note as it is, with Intent ids turned into names.
 */
export function workloadReason(note: string | undefined, nameOf: (id: IntentId) => string): string | null {
	if (note === undefined || note.trim() === "") {
		return null;
	}
	const waited = /^could not get (.+): Intent (i[0-9a-z]{8}) still holds it after \d+ retries$/.exec(note);
	if (waited) {
		const symbols = (waited[1] as string).split(", ").map((symbol) => symbolName(symbol as never));
		return `Gave up waiting: ${nameOf(waited[2] as IntentId)} was changing ${symbols.join(", ")}.`;
	}
	return note.replace(/\bi[0-9a-z]{8}\b/g, (id) => nameOf(id as IntentId));
}

/** The order of a tag: "w7_2" before "w7_11". */
function tagOrder(name: string): number[] {
	return (name.match(/\d+/g) ?? []).map(Number);
}

/** Every workload Intent on the board, in the order the workload made them. */
export function workloadLines(intents: Readonly<Record<IntentId, IntentView>>, nameOf: (id: IntentId) => string): WorkloadLine[] {
	const lines = Object.values(intents)
		.filter((intent) => intent.kind === "workload")
		.map((intent): WorkloadLine => {
			const tagged = /^(w\d+_\d+):\s*(.*)$/.exec(intent.goal);
			const state = STATE[intent.status];
			return {
				id: intent.id,
				name: tagged ? (tagged[1] as string) : nameOf(intent.id),
				edit: tagged ? (tagged[2] as string) : intent.goal,
				status: intent.status,
				state,
				reason: state === "landed" || state === "in flight" ? null : workloadReason(intent.lastNote, nameOf),
			};
		});
	return lines.sort((a, b) => {
		const [x, y] = [tagOrder(a.name), tagOrder(b.name)];
		for (let i = 0; i < Math.max(x.length, y.length); i++) {
			const d = (x[i] ?? -1) - (y[i] ?? -1);
			if (d !== 0) {
				return d;
			}
		}
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
}
