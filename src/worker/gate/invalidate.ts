// What happens to everyone else when something lands on trunk. T16 fills this in: it finds each
// in-flight Intent whose premises no longer hold and turns it stale.
import type { CommitSha, IntentId, SymbolId } from "../../shared/types";
import type { FileMap } from "../ports/repo-store";

export interface Landed {
	/** The new trunk commit. */
	commit: CommitSha;
	/** The Intent that landed, or null when someone pushed to trunk outside the gate. */
	byIntent: IntentId | null;
	/** Exported symbols whose type surface changed or disappeared. */
	changedSymbols: SymbolId[];
	/** Trunk's files at `commit`. */
	newTrunkFiles: FileMap;
}

export type Invalidate = (env: Pick<Env, "HUB" | "INTENT" | "LEDGER" | "LOADER">, landed: Landed) => Promise<void>;

export const invalidate: Invalidate = async () => {
	// Nothing yet.
};
