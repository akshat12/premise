/** The Workflow instance id for a run: the Intent id plus the attempt number (0 for the first run, n for re-derive n). */
export function workflowInstanceId(intentId: string, attempt: number): string {
	return `${intentId}-${attempt}`;
}
