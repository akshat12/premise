import type { IntentId } from "../../shared/types";
import type { WorkloadLine } from "../lib/workload";

interface WorkloadListProps {
	lines: readonly WorkloadLine[];
	/** Opens one of them in the details panel. */
	onSelect: (id: IntentId) => void;
}

/** The workload's Intents, one line each: its tag, what the edit does, where it got to, and why, when it did not land. */
export function WorkloadList({ lines, onSelect }: WorkloadListProps) {
	if (lines.length === 0) {
		return <p className="workload-empty">No workload Intents on the board.</p>;
	}
	return (
		<ol className="workload-list">
			{lines.map((line) => (
				<li key={line.id}>
					<button type="button" className="workload-line" data-state={line.state} onClick={() => onSelect(line.id)}>
						<span className="callsign workload-name">{line.name}</span>
						<span className="workload-edit">{line.edit}</span>
						<span className="label workload-state">{line.state}</span>
						{line.reason ? <span className="workload-reason">{line.reason}</span> : null}
					</button>
				</li>
			))}
		</ol>
	);
}
