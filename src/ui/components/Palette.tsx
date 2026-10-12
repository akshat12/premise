import { CommandPalette, Dialog } from "@cloudflare/kumo";
import { useMemo, useState } from "react";

export interface Command {
	id: string;
	title: string;
	run: () => void;
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

/** ⌘K: every action on the screen, and a jump to any strip, from the keyboard. */
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
