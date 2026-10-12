import { Button } from "@cloudflare/kumo";
import { DotsThree } from "@phosphor-icons/react";
import type { Layout } from "../lib/view";
import { releaseFocus } from "./TopBar";

interface SimpleBarProps {
	layout: Layout;
	/** The view tabs. */
	views: React.ReactNode;
	/** Opens the list of everything else the app can do (the command palette). */
	onMore: () => void;
}

/**
 * The top bar while a demo recording is on screen: the name, one line saying what Premise is,
 * and the three views. Everything a newcomer does not need (the live board, dispatching, speeds)
 * is one click away under "More", not in front of the story.
 */
export function SimpleBar({ layout, views, onMore }: SimpleBarProps) {
	return (
		<header className="simplebar" data-layout={layout}>
			<span className="callsign simplebar-name">Premise</span>
			{layout === "phone" ? null : <span className="simplebar-tagline">Many agents, one codebase. Premise tracks what each one relies on.</span>}
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
