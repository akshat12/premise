import { Button, SkeletonLine } from "@cloudflare/kumo";
import { ArrowsInSimple, ArrowsOutSimple, CaretDown, CaretRight } from "@phosphor-icons/react";
import { useState } from "react";
import { countChanges, type DiffState, type FileDiff, hunkHeader, type IntentDiff, numberLines, totals } from "../lib/diff";
import "../diff.css";

/** How many files start open. The rest are a click away, so a long diff does not bury the first of it. */
const OPEN_AT_FIRST = 2;

const MINUS = "−";

function FileBody({ file }: { file: FileDiff }) {
	if (file.binary) {
		return <p className="diff-aside">Not a text file, so there are no lines to show.</p>;
	}
	if (file.hunks.length === 0) {
		return <p className="diff-aside">{file.truncated ? "Too large to show here." : file.status === "modified" ? "Only the end of the file changed (its last line break)." : "The file is empty."}</p>;
	}
	return (
		<div className="diff">
			{file.hunks.map((hunk) => (
				<div key={`${hunk.oldStart}:${hunk.newStart}`}>
					<div className="diff-hunk">{hunkHeader(hunk)}</div>
					{numberLines(hunk).map((line, index) => (
						// A hunk's lines never change order, so their position is a stable key.
						<div key={index} className="diff-line" data-kind={line.kind}>
							<span className="diff-no">{line.no}</span>
							<span className="diff-sign">{line.kind}</span>
							<span className="diff-text">{line.text === "" ? " " : line.text}</span>
						</div>
					))}
				</div>
			))}
			{file.truncated ? <p className="diff-aside">The rest of this file's changes are not shown: it has more than 400 changed lines.</p> : null}
		</div>
	);
}

function FileBlock({ file, open, onToggle, bodyId }: { file: FileDiff; open: boolean; onToggle: () => void; bodyId: string }) {
	const { added, removed } = countChanges(file);
	return (
		<li className="changes-file">
			<button type="button" className="changes-file-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
				{open ? <CaretDown size={12} aria-hidden="true" style={{ flex: "none" }} /> : <CaretRight size={12} aria-hidden="true" style={{ flex: "none" }} />}
				<span className="changes-file-path" title={file.path}>
					<bdi>{file.path}</bdi>
				</span>
				{file.status === "modified" ? null : <span className="changes-file-status">{file.status}</span>}
				<span className="changes-file-counts">
					<span className="diff-added" aria-label={`${added} added`}>
						+{added}
					</span>
					<span className="diff-removed" aria-label={`${removed} removed`}>
						{MINUS}
						{removed}
					</span>
				</span>
			</button>
			{open ? (
				<div id={bodyId}>
					<FileBody file={file} />
				</div>
			) : null}
		</li>
	);
}

/** Why there is no diff to show, in a sentence. null when there is one. */
function emptyReason(diff: IntentDiff | null, replay: boolean): string | null {
	if (diff === null) {
		return replay ? "The recording does not include this Intent's changes." : "Nothing pushed yet.";
	}
	if (diff.unavailable) {
		return "Its fork can no longer be read, so its changes cannot be shown.";
	}
	if (diff.files.length > 0) {
		return null;
	}
	if (diff.head === null) {
		return replay ? "It had pushed nothing when the recording ended." : "Nothing pushed yet.";
	}
	return "What it pushed changed no files.";
}

interface ChangesProps {
	diff: DiffState;
	/** Watching a recording: the diff is the one saved with it, not one fetched now. */
	replay: boolean;
	/** The column has the whole drawer. */
	expanded: boolean;
	onToggleExpanded: () => void;
}

/** What the Intent changed: each file it touched, with its unified diff. This is where its work is reviewed. */
export function Changes({ diff, replay, expanded, onToggleExpanded }: ChangesProps) {
	// Which files the reader has opened or closed. Until they choose, the first two are open.
	const [chosen, setChosen] = useState<Record<string, boolean>>({});
	const reason = diff === "loading" ? null : emptyReason(diff, replay);
	const shown = diff !== "loading" && diff !== null && reason === null ? diff : null;
	const sum = shown === null ? null : totals(shown);
	return (
		<>
			<div className="changes-head">
				<h3>Changes</h3>
				{shown !== null ? (
					<Button variant="ghost" size="xs" aria-pressed={expanded} title={expanded ? "Back to the Intent's details" : "Give the changes the whole drawer"} onClick={onToggleExpanded}>
						{expanded ? <ArrowsInSimple size={12} aria-hidden="true" /> : <ArrowsOutSimple size={12} aria-hidden="true" />}
						{expanded ? "Show details" : "Expand"}
					</Button>
				) : null}
			</div>
			{diff === "loading" ? (
				<div className="flex flex-col gap-2" role="status" aria-label="Reading the Intent's fork">
					<SkeletonLine />
					<SkeletonLine />
					<SkeletonLine />
				</div>
			) : null}
			{reason !== null ? <p className="changes-note">{reason}</p> : null}
			{shown !== null && sum !== null ? (
				<>
					<p className="changes-note">
						{sum.files} file{sum.files === 1 ? "" : "s"} changed, <span className="diff-added">+{sum.added}</span>{" "}
						<span className="diff-removed">
							{MINUS}
							{sum.removed}
						</span>
						{shown.staged ? ". Edited in its fork, not pushed yet." : replay ? ". As it stood when the recording ended." : "."}
						{shown.truncated ? ` Showing the first ${shown.files.length} of ${sum.files} files.` : ""}
					</p>
					<ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
						{shown.files.map((file, index) => (
							<FileBlock key={file.path} file={file} bodyId={`changes-${index}`} open={chosen[file.path] ?? index < OPEN_AT_FIRST} onToggle={() => setChosen((now) => ({ ...now, [file.path]: !(now[file.path] ?? index < OPEN_AT_FIRST) }))} />
						))}
					</ul>
				</>
			) : null}
		</>
	);
}
