import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { ServerApi } from "./server-api.js";
import { createTerminalMcpServer } from "./terminal-mcp.js";
import { addressOf, hasLegacyLayout, currentInstallation, resolveFolder, type InstanceLabel, type Installation, type InstallationsDeps } from "./installations.js";

/** What the launcher gives an installation's own MCP entry point. */
export interface McpHandOver extends Pick<Installation, "serverUrl" | "token"> {
  /** `dist/installation-mcp.js` of the installation's build. */
  entry: string;
  folder: string;
  instance: InstanceLabel & { version?: string };
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (count: number) => NUMBER_WORDS[count] ?? String(count);

const shown = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** The single tool of a launcher that cannot serve an instance: it says what the user has to do. */
export function setupNeededServer(message: string): McpServer {
  const server = new McpServer({ name: "redline", version: "0.0.0" }, { instructions: message });
  server.registerTool("setup_needed", { description: "Redline cannot be used from this folder yet: tells what the user has to do." }, async () => ({ content: [{ type: "text" as const, text: message }] }));
  return server;
}

export const LEGACY_MCP_MESSAGE = "Redline changed: this computer still has the old single installation. Tell the user to run redline migrate in a terminal, then /mcp and reconnect redline.";

/** The old single installation is still there: the usual tools exist, and each one answers the migrate message (no call reaches a server). */
const legacyServer = (folder: string): McpServer => createTerminalMcpServer({ api: new ServerApi("http://127.0.0.1:0", ""), folder, refusal: LEGACY_MCP_MESSAGE });

const unlinkedMessage = (folder: string, installations: Installation[], home: string): string =>
  installations.length === 0
    ? "No Redline instance is set up on this computer. Tell the user to run `redline setup <address>`, then /mcp and reconnect redline."
    : [
        `This folder (${shown(folder, home)}) is linked to no Redline instance, and this computer has ${countWord(installations.length)}:`,
        `${installations.map((installation) => `${installation.name} (${addressOf(installation.serverUrl)})`).join(", ")}.`,
        "Ask the user which one, to run `redline link <instance>` in this folder, then /mcp and reconnect redline.",
      ].join("\n");

const orphanMessage = (serverUrl: string): string =>
  [
    `This folder is linked to ${addressOf(serverUrl)}, which is not installed on this computer.`,
    `Tell the user to run \`redline setup ${serverUrl}\` (or \`redline link <instance>\` for another one),`,
    "then /mcp and reconnect redline.",
  ].join("\n");

const tooOldMessage = ({ name, serverUrl, version }: Installation): string =>
  `The ${name} installation${version ? ` (v${version})` : ""} is too old to serve the MCP from here. Tell the user to run \`redline update ${serverUrl}\`, then /mcp and reconnect redline.`;

/**
 * `redline mcp`: resolves the folder, then either hands over to the linked installation's own MCP (returns nothing: the
 * handed-over code serves stdio in this same process) or returns the minimal MCP the caller serves instead.
 */
export async function launchMcp({ configDir, folder, home, fetchInstance, handOver }: { configDir: string; folder: string; home: string; fetchInstance: InstallationsDeps["fetchInstance"]; handOver(to: McpHandOver): Promise<unknown> }): Promise<McpServer | undefined> {
  if (hasLegacyLayout(configDir)) return legacyServer(folder);
  const resolved = resolveFolder(configDir, folder);
  if (resolved.kind === "unlinked") return setupNeededServer(unlinkedMessage(folder, resolved.installations, home));
  if (resolved.kind === "orphan") return setupNeededServer(orphanMessage(resolved.serverUrl));
  const installation = await currentInstallation(configDir, resolved.installation, fetchInstance);
  const entry = join(dirname(installation.entry), "installation-mcp.js");
  try {
    await handOver({ entry, folder, serverUrl: installation.serverUrl, token: installation.token, instance: { name: installation.name, address: addressOf(installation.serverUrl), version: installation.version } });
  } catch {
    return setupNeededServer(tooOldMessage(installation));
  }
  return undefined;
}

/** The real hand-over: loads the installation's own build and runs its entry point. */
export async function importAndServe({ entry, ...rest }: McpHandOver): Promise<void> {
  const { serveInstallationMcp } = (await import(pathToFileURL(entry).href)) as { serveInstallationMcp(options: Omit<McpHandOver, "entry">): Promise<void> };
  await serveInstallationMcp(rest);
}
