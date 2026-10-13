import { CommandPalette, Dialog } from "@cloudflare/kumo";
import { useMemo, useState } from "react";

export interface Command {
	id: string;
	title: string;
	run: () => void;
	/** A few words under the title where it is shown as a button: what it needs, or what it does. */
	hint?: string;
	/** Only of use with a keyboard, so it is left out of the list a touch screen gets. */
	keyboardOnly?: boolean;
}

interface CommandGroup {
	id: string;
	label: string;
	items: Command[];
}

interface PaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	actions: Command[];
	jumps: Command[];
}

/**
 * "More" on a touch screen: the same actions as plain buttons. The palette below is made for a
 * keyboard: it opens the on-screen keyboard over half the page, and on some phones a tap on one
 * of its items does not arrive as a click at all. A list of buttons has neither problem.
 */
export function MoreSheet({ open, onOpenChange, actions, jumps }: PaletteProps) {
	const choose = (command: Command) => {
		onOpenChange(false);
		command.run();
	};
	const row = (command: Command) => (
		<li key={command.id}>
			<button type="button" className="more-item" onClick={() => choose(command)}>
				<span>{command.title}</span>
				{command.hint ? <span className="more-hint">{command.hint}</span> : null}
			</button>
		</li>
	);
	const shown = actions.filter((command) => !command.keyboardOnly);
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="more-sheet outline-none" size="sm">
				<div className="more-head">
					<Dialog.Title className="label">More</Dialog.Title>
					<button type="button" className="more-close label" onClick={() => onOpenChange(false)}>
						Close
					</button>
				</div>
				<ul className="more-list">{shown.map(row)}</ul>
				{jumps.length > 0 ? (
					<>
						<h3 className="label more-group">Open an agent's Intent</h3>
						<ul className="more-list">{jumps.map(row)}</ul>
					</>
				) : null}
			</Dialog>
		</Dialog.Root>
	);
}

/** ⌘K: every action on the screen, and a jump to any agent's Intent, from the keyboard. */
export function Palette({ open, onOpenChange, actions, jumps }: PaletteProps) {
	const [search, setSearch] = useState("");
	const groups = useMemo<CommandGroup[]>(() => {
		const needle = search.trim().toLowerCase();
		const match = (command: Command) => needle === "" || command.title.toLowerCase().includes(needle);
		return [
			{ id: "actions", label: "Actions", items: actions.filter(match) },
			{ id: "jump", label: "Jump to", items: jumps.filter(match) },
		].filter((group) => group.items.length > 0);
	}, [search, actions, jumps]);

	const choose = (command: Command) => {
		onOpenChange(false);
		setSearch("");
		command.run();
	};

	return (
		<CommandPalette.Root<CommandGroup, Command>
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) {
					setSearch("");
				}
			}}
			items={groups}
			value={search}
			onValueChange={setSearch}
			itemToStringValue={(group) => group.label}
			onSelect={(command) => choose(command)}
			getSelectableItems={(all) => all.flatMap((group) => group.items)}
		>
			<CommandPalette.Input placeholder="Type a command, or an agent's name to jump to" />
			<CommandPalette.List>
				<CommandPalette.Results>
					{(group: CommandGroup) => (
						<CommandPalette.Group key={group.id} items={group.items}>
							<CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
							<CommandPalette.Items>
								{(command: Command) => (
									<CommandPalette.Item key={command.id} value={command} onClick={() => choose(command)}>
										{command.title}
									</CommandPalette.Item>
								)}
							</CommandPalette.Items>
						</CommandPalette.Group>
					)}
				</CommandPalette.Results>
				<CommandPalette.Empty>No command matches that.</CommandPalette.Empty>
			</CommandPalette.List>
		</CommandPalette.Root>
	);
}

const SHORTCUTS: [string[], string][] = [
	[["→"], "Replay: the next step of the story"],
	[["←"], "Replay: the step before"],
	[["Space"], "Replay: play it through, or pause"],
	[["j"], "Open the next agent's Intent"],
	[["k"], "Open the one before"],
	[["Esc"], "Close the details panel"],
	[["⌘", "K"], "Everything else: the live board, dispatching, the other views"],
	[["?"], "Show these shortcuts"],
];

/** The `?` sheet. */
export function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 outline-none" size="sm">
				<Dialog.Title className="text-base font-semibold">Keyboard shortcuts</Dialog.Title>
				<table style={{ marginTop: 12, fontSize: 13, borderCollapse: "collapse", width: "100%" }}>
					<tbody>
						{SHORTCUTS.map(([keys, what]) => (
							<tr key={what}>
								<td style={{ padding: "4px 12px 4px 0", whiteSpace: "nowrap" }}>
									{keys.map((key) => (
										<kbd key={key} style={{ marginRight: 4 }}>
											{key}
										</kbd>
									))}
								</td>
								<td style={{ padding: "4px 0" }}>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
			</Dialog>
		</Dialog.Root>
	);
}
