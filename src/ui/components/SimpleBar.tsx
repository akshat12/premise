import { Button } from "@cloudflare/kumo";
import { DotsThree } from "@phosphor-icons/react";
import type { Layout } from "../lib/view";

/**
 * Kumo's tabs keep the arrow keys for moving between tabs, which is right for a keyboard user. But
 * after a click the tab keeps focus, and the → key (the story's next step) would go to the tabs
 * instead. So a pointer click gives focus back to the page; keyboard use is untouched.
 */
export function releaseFocus(event: React.PointerEvent<HTMLElement>) {
	const tabs = event.currentTarget;
	window.setTimeout(() => {
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && tabs.contains(focused)) {
			focused.blur();
		}
	}, 0);
}

/** What kind of run is being replayed: a short label, a few more words where there is room, and a sentence for the tooltip. */
export interface RunKind {
	label: string;
	extra: string;
	detail: string;
}

interface SimpleBarProps {
	layout: Layout;
	/** The two tabs: Demo and Live. */
	views: React.ReactNode;
	/** Opens the list of everything else the app can do (the command palette). */
	onMore: () => void;
	/** Opens the slides that explain Premise, over the page. */
	onHow: () => void;
	kind?: RunKind;
}

/**
 * The top bar: the name, one line saying what Premise is, what kind of run is on screen, and the
 * two tabs. What a newcomer does not need is one click away under "More", not in front of the story:
 * the shortcuts, and, for the owner only (see ADMIN in App.tsx), dispatching by hand and resetting.
 */
export function SimpleBar({ layout, views, onMore, onHow, kind }: SimpleBarProps) {
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
			{/* A link to the same deck at /slides/: a plain click opens it over this page instead. */}
			<a
				className="label-button simplebar-how"
				href="/slides/"
				onClick={(event) => {
					if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
						event.preventDefault();
						onHow();
					}
				}}
			>
				{layout === "phone" ? "How?" : "How does it work?"}
			</a>
			<Button variant="ghost" size="sm" shape="square" aria-label="More" title="More (⌘K)" onClick={onMore}>
				<DotsThree size={20} weight="bold" />
			</Button>
		</header>
	);
}
