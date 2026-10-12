import { Button } from "@cloudflare/kumo";
import { DotsThree } from "@phosphor-icons/react";
import type { Layout } from "../lib/view";
import { releaseFocus } from "./TopBar";

/** What kind of run is being replayed: a short label, a few more words where there is room, and a sentence for the tooltip. */
export interface RunKind {
	label: string;
	extra: string;
	detail: string;
}

interface SimpleBarProps {
	layout: Layout;
	/** The view tabs. */
	views: React.ReactNode;
	/** Opens the list of everything else the app can do (the command palette). */
	onMore: () => void;
	kind?: RunKind;
}

/**
 * The top bar while a demo recording is on screen: the name, one line saying what Premise is,
 * and the three views. Everything a newcomer does not need (the live board, dispatching, speeds)
 * is one click away under "More", not in front of the story.
 */
export function SimpleBar({ layout, views, onMore, kind }: SimpleBarProps) {
	return (
		<header className="simplebar" data-layout={layout}>
			<span className="callsign simplebar-name">Premise</span>
			{layout === "phone" ? null : (
				<>
					<span className="simplebar-rule" aria-hidden="true" />
					<span className="simplebar-tagline">Many agents, one codebase. Premise tracks what each one relies on.</span>
				</>
			)}
			<span className="label simplebar-replay" title={kind?.detail}>
				<span>
					{kind?.label ?? "Replay of a recorded run"}
					{kind ? <span className="simplebar-extra"> · {kind.extra}</span> : null}
				</span>
			</span>
			{/* A clicked tab gives focus back to the page, so the arrow keys go on walking the story. */}
			<div className="simplebar-views" onPointerUp={releaseFocus}>
				{views}
			</div>
			<Button variant="ghost" size="sm" shape="square" aria-label="More: the live board, dispatching, keyboard shortcuts" title="More (⌘K)" onClick={onMore}>
				<DotsThree size={20} weight="bold" />
			</Button>
		</header>
	);
}
