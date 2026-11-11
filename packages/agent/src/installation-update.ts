import { renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acceptsProtocol, hostProtocol } from "./host-protocol.js";
import { addressOf, findInstallation, isOlder, pickInstallation, SetupRefusal, type Installation, type InstallationsDeps } from "./installations.js";
import { liveSessions } from "./mcp-sessions.js";

/** The installation `wanted` names, or a refusal saying it is not set up. */
function named(configDir: string, wanted: string): Installation {
  try {
    return pickInstallation(configDir, wanted);
  } catch (error) {
    throw new SetupRefusal((error as Error).message);
  }
}

export interface UpdateResult {
  /** `current`: the server has nothing newer than what is installed. */
  outcome: "updated" | "current";
  name: string;
  address: string;
  from?: string;
  to?: string;
  /** Agents the host restarts, each after its run. */
  restarted: string[];
  /** `updated`: the build is newer than the global command, which was refreshed from it. */
  globalCommand: "kept" | "updated";
  commandVersion: string;
}

/**
 * `redline update <instance|address>`: installs the server's current build into the installation (a fresh folder swapped in, so a
 * failed install changes nothing), restarts its agents after their runs, and refreshes the global command only from a newer build.
 */
export async function updateInstallation({ configDir, wanted, deps }: { configDir: string; wanted: string; deps: InstallationsDeps }): Promise<UpdateResult> {
  const installation = named(configDir, wanted);
  const address = addressOf(installation.serverUrl);
  const { name, serverUrl, token } = installation;
  const info = await deps.fetchInstance(serverUrl, token).catch((error: Error) => {
    throw new SetupRefusal(`Cannot reach ${name} at ${address}: ${error.message}`);
  });
  if (!acceptsProtocol(hostProtocol(deps.commandVersion, deps.hostProtocol), info.hostProtocol)) {
    throw new SetupRefusal(
      `${name}'s server still runs ${info.version ? `v${info.version}` : "an older version"}, too old for this redline command (v${deps.commandVersion}, accepts v${deps.oldestAccepted} and later).\n  Its agents stay refused until the server is upgraded.`,
    );
  }
  const common = { name, address, commandVersion: deps.commandVersion };
  if (info.buildHash && info.buildHash === installation.buildHash) {
    return { ...common, outcome: "current", from: installation.version, to: installation.version, restarted: [], globalCommand: "kept" };
  }

  const fresh = join(installation.dir, ".npm-new");
  const old = join(installation.dir, ".npm-old");
  rmSync(fresh, { recursive: true, force: true });
  try {
    await deps.install(serverUrl, fresh);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw new SetupRefusal(`Could not update ${name}: ${(error as Error).message.replace(/\.$/, "")}.\n  Nothing was changed.`);
  }
  rmSync(old, { recursive: true, force: true });
  renameSync(installation.prefix, old);
  renameSync(fresh, installation.prefix);
  rmSync(old, { recursive: true, force: true });

  const updated = findInstallation(configDir, installation.id)!;
  const to = updated.version ?? info.version;
  const restarted = await deps.restartAgents(updated);
  let globalCommand: UpdateResult["globalCommand"] = "kept";
  if (to && isOlder(deps.commandVersion, to)) {
    await deps.installGlobalCommand(serverUrl).catch((error: Error) => {
      throw new SetupRefusal(`${name} is updated, but the redline command could not be refreshed from it: ${error.message}`);
    });
    globalCommand = "updated";
  }
  return { ...common, outcome: "updated", from: installation.version, to, restarted, globalCommand };
}

/** The lines `redline update` prints (texts of the update.html mock-up). */
export function updateReport({ outcome, name, address, from, to, restarted, globalCommand, commandVersion }: UpdateResult): string[] {
  if (outcome === "current") return [`✓ ${name} is up to date (v${to}, ${address}): nothing newer on the server.`];
  return [
    `${name}: v${from ?? "?"} → v${to ?? "?"} (${address})`,
    `✓ Installed. ${restarted.length > 0 ? `Agents restarted, each after its run: ${restarted.join(", ")}.` : `No agent of ${name} is running.`}`,
    globalCommand === "updated" ? `  The redline command was updated to v${to} (this build is newer).` : `  The redline command stays v${commandVersion} (it only follows a newer build).`,
    `  Claude Code sessions on ${name}: type /mcp and reconnect redline.`,
  ];
}

const shown = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * Why the installation's files cannot be pulled now, naming what uses them: an agent that is not stopped, or a Claude Code session
 * (its MCP process); undefined when nothing does. Doctor and the Instances tab use it too.
 */
export async function installationInUse(installation: Installation, deps: Pick<InstallationsDeps, "agentsOf">, home = homedir()): Promise<string | undefined> {
  const running = (await deps.agentsOf(installation)).filter((agent) => agent.running).map((agent) => agent.name);
  if (running.length > 0) {
    return `${running.length === 1 ? "An agent" : "Agents"} of ${installation.name} ${running.length === 1 ? "is" : "are"} running (${running.join(", ")}). Stop ${running.length === 1 ? "it" : "them"} first: redline, then x.`;
  }
  const sessions = liveSessions(installation.dir);
  if (sessions.length > 0) {
    return `${sessions.length === 1 ? "A Claude Code session" : "Claude Code sessions"} of ${installation.name} ${sessions.length === 1 ? "is" : "are"} running (${sessions.map((session) => shown(session.folder, home)).join(", ")}). Close ${sessions.length === 1 ? "it" : "them"}, then run redline remove ${installation.id} again.`;
  }
  return undefined;
}

export interface RemoveResult {
  name: string;
  dir: string;
  removedAgents: string[];
}

/** `redline remove <instance>`: refused while in use; folders linked to it keep their link (they report it as not installed). */
export async function removeInstallation({ configDir, wanted, deps, home = homedir() }: { configDir: string; wanted: string; deps: InstallationsDeps; home?: string }): Promise<RemoveResult> {
  const installation = named(configDir, wanted);
  const blocked = await installationInUse(installation, deps, home);
  if (blocked) throw new SetupRefusal(blocked);
  const removedAgents = await deps.removeStoppedAgents(installation);
  rmSync(installation.dir, { recursive: true, force: true });
  return { name: installation.name, dir: installation.dir, removedAgents };
}

export function removeReport({ name, dir, removedAgents }: RemoveResult, { home = homedir() }: { home?: string } = {}): string[] {
  return [`✓ Removed ${name} (${shown(dir, home)})${removedAgents.length > 0 ? " and its stopped agents" : ""}.`, "  Folders linked to it now say how to install it again."];
}
