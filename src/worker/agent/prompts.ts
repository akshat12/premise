// What the agent is told. One system prompt for the whole run: the plan and work phases share a
// conversation, and providers require the system prompt and tool list to stay the same within one.
import type { Assertion, Intent, TaskDef } from "../../shared/types";

export const SYSTEM_PROMPT = `You are a coding agent working on one Intent in a shared TypeScript repository. Other agents are changing the same repository at the same time. You have no shell: the tools are the only way to see or change code.

The work has two phases.

Plan phase (you start here):
- Read what you need with list_files, read_file, search_symbols and read_symbol. Reading tells the platform what your work relies on, so read what matters and not more.
- If your plan depends on how a function you are not changing behaves, not just on its types, call assert_premise for it. Examples: you will add code to a catch block, so you rely on a function throwing; you will branch on null, so you rely on it returning null for some input. Write the check yourself: a few lines that pass on the code as it is now. The platform re-checks your assertions whenever trunk changes underneath you, and tells you if one stops holding. Tests that use a stand-in for that function cannot tell you this.
- Then call declare_changes. If you asserted nothing, pass "no_behaviour": true to say your plan depends on no such behaviour.
- In declare_changes, give the smallest set of exported symbols you will change. Use mode "interface" only if you will change an exported signature or type, or add a new export. Otherwise use "body". Write at most three short "why" lines. Test files are not declared.

Work phase (after declare_changes is granted):
- Change files with write_file, which takes the complete new content of a file.
- Add the acceptance tests you were given. Each names a test file and a test name; the file must export a "tests" object with exactly that name as a key. Look at an existing file under tests/ for the format.
- Change only the symbols you declared. If you are told another Intent keeps a symbol, leave it alone.
- Call run_checks, fix whatever fails, then call submit.

Always answer with a tool call. Keep any text to one short sentence.`;

/** Appended to the result of declare_changes when the claims are granted. */
export const WORK_PHASE_NOTE = "You are now in the work phase. Use write_file, then run_checks, then submit.";

export const NUDGE = "Continue by calling a tool.";

export interface Briefing {
	intent: Intent;
	task?: Pick<TaskDef, "title" | "hints">;
	/** Pre-written assertions the agent may adopt by id. */
	adoptable: Pick<Assertion, "id" | "description">[];
	mode: "fresh" | "rederive";
	/** Re-derive only: why the earlier work did not land. */
	reason?: string;
}

/** The block added for a re-derive: what broke, and what the agent thought last time. */
export function rederiveBlock(intent: Intent, reason?: string): string {
	const broken = intent.premises.filter((premise) => premise.state === "broken");
	const lines = [
		"This is a re-derive. Trunk changed underneath you, and your earlier work no longer holds.",
		"",
		"Premises that broke:",
		...(broken.length > 0
			? broken.map((premise) => `- ${premise.assertion?.description ?? premise.symbol}: ${premise.brokenBy?.reason ?? "it no longer holds"}`)
			: ["- (none recorded)"]),
	];
	if (broken.some((premise) => premise.source === "asserted")) {
		lines.push("Before declare_changes, say what you rely on about each of those symbols now: assert_premise with a check that passes on the code as it is today.");
	}
	if (reason !== undefined && reason.trim() !== "") {
		lines.push("", "Why your earlier work did not land:", `- ${reason.trim()}`);
		if (reason.includes("landed Intent")) {
			// Its own change is fine; the trouble is code already on trunk that depended on the old behaviour.
			lines.push(
				"Work that has already landed depends on the behaviour you changed. Keep your change, and also update the code that depended on the old behaviour so that the landed acceptance check passes again: read that test and the code it exercises, and include the symbols you need to edit in declare_changes.",
				"You may not edit or delete that test. run_checks runs it for you.",
			);
		}
	}
	if (intent.why.length > 0) {
		lines.push("", "Your reasoning last time:", ...intent.why.map((line) => `- ${line}`));
	}
	if (intent.rejectedAlternatives.length > 0) {
		lines.push("", "Alternatives you rejected last time:", ...intent.rejectedAlternatives.map((line) => `- ${line}`));
	}
	lines.push("", "Trunk changed underneath you. Re-implement the same goal on the new trunk. The acceptance checks are unchanged.", "Read the code again before you plan: do not assume it still behaves the way it did.");
	return lines.join("\n");
}

/** The first user message: the goal, the acceptance checks, and what else the agent should know. */
export function briefing({ intent, task, adoptable, mode, reason }: Briefing): string {
	const lines = [`Intent ${intent.id}${task?.title ? `: ${task.title}` : ""}`, "", `Goal: ${intent.goal}`, "", "Acceptance checks (fixed; you must add these tests and make them pass):"];
	for (const check of intent.acceptance) {
		lines.push(`- ${check.id}: ${check.description}`, `  test file: ${check.testFile}`, `  test name: ${JSON.stringify(check.testName)}`);
	}
	if (task?.hints && task.hints.length > 0) {
		lines.push("", "Hints:", ...task.hints.map((hint) => `- ${hint}`));
	}
	if (adoptable.length > 0) {
		lines.push("", 'Assertions you can adopt with assert_premise { "adopt": "<id>" }:', ...adoptable.map((assertion) => `- ${assertion.id}: ${assertion.description}`));
	}
	if (mode === "rederive") {
		lines.push("", rederiveBlock(intent, reason));
	}
	lines.push("", "Start by reading the code you need.");
	return lines.join("\n");
}
