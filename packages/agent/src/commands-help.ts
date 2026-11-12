/** The commands of the CLI as `redline help` prints them and the `?` overlay of the agents screen shows them (board `aide.html`). */
export interface CommandHelp {
  command: string;
  description: string;
  /** A line of options under the command. */
  options?: string;
}

export const COMMANDS: CommandHelp[] = [
  { command: "redline", description: "this screen (alias: redline agents)" },
  { command: "redline setup <address>", description: "install an instance (alias: redline login)" },
  { command: "redline link [<instance>]", description: "link this folder to an instance, no agent" },
  { command: "redline agent", description: "start an agent in this folder" },
  { command: "redline agent --global --instance <i>", description: "start the global agent of an instance" },
  { command: "redline update <instance|address>", description: "update an installation from its server" },
  { command: "redline remove <instance>", description: "remove an installation" },
  { command: "redline doctor", description: "check every installation, the MCP, this folder" },
  { command: "redline migrate", description: "move the old single installation (once per computer)", options: "--now stops the runs in progress, --name <address>=<name> renames one, --forget <address> drops a server that does not answer" },
  { command: "redline help", description: "this list, in the shell" },
];

const COMMAND_WIDTH = 36;

/** The command padded to the description column, with at least one space after a long one. */
export const commandCell = (command: string): string => (command.length >= COMMAND_WIDTH ? `${command} ` : command.padEnd(COMMAND_WIDTH));

export function helpLines(): string[] {
  return ["Commands", "", ...COMMANDS.flatMap(({ command, description, options }) => [`  ${commandCell(command)}${description}`, ...(options ? [`          ${options}`] : [])])];
}
