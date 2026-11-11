import { homedir } from "node:os";
import { AgentRegistry } from "./agent-registry.js";
import { MIGRATE_STOP_REASON } from "./activity.js";
import { HostClient } from "./host-client.js";
import type { HostAgent } from "./host-protocol.js";
import { createInstallation, fallbackName, installationId, listInstallations, type InstallationsDeps, type InstanceInfo } from "./installations.js";
import { normalizeServerUrl, readLogins, replaceLogins, type Login } from "./login.js";

export { MIGRATE_STOP_REASON };

/** The refusal of every command but migrate, doctor and help while the old single login remains; bare `redline` gets the short one. */
export const legacyRefusal = (short: boolean): string =>
  `This computer still has the old Redline installation (one login for every server).\n  Run redline migrate first${short ? "." : ": it moves each server to its own installation."}`;

/** What migrate asks of the agent host: its agents, and to stop one with a reason. Absent when no host runs. */
export interface MigrateHost {
  agents(): Promise<HostAgent[]>;
  stop(agentId: string, reason: string): Promise<void>;
  /** Resolves once the host has exited (it does so by itself when no agent runs and no screen is attached). */
  untilGone(): Promise<void>;
}

/** The running host of this config dir, or undefined. */
export async function connectMigrateHost(configDir: string, timeoutMs = 20_000): Promise<MigrateHost | undefined> {
  let client: HostClient;
  try {
    client = await HostClient.connect(configDir);
  } catch {
    return undefined;
  }
  return {
    agents: () => client.list(),
    stop: async (agentId, reason) => void (await client.stop(agentId, reason)),
    async untilGone() {
      client.close();
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          (await HostClient.connect(configDir)).close();
        } catch {
          return;
        }
        if (Date.now() > deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
  };
}

export interface MigrateOptions {
  configDir: string;
  deps: InstallationsDeps;
  host?: MigrateHost;
  /** `--now`: stop the runs in progress instead of waiting for them. */
  now?: boolean;
  /** `--name <address>=<name>`, by address. */
  names?: Record<string, string>;
  out(line: string): void;
  sleep?(ms: number): Promise<void>;
  home?: string;
  color?: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const addressOf = (serverUrl: string) => serverUrl.replace(/^https?:\/\//, "");

interface Planned {
  login: Login;
  serverUrl: string;
  name: string;
  nameChosen: boolean;
}

/**
 * Moves the old single login to one installation per server: stops the agent host (waiting for the runs unless `now`), installs each
 * server's build, moves its token, and registers the MCP. A server that cannot be moved (name taken, token refused, build not
 * installable) stays in the old login, so the command can be run again.
 */
export async function migrateLegacy(options: MigrateOptions): Promise<{ migrated: number; left: number }> {
  const { configDir, deps, host, out, now = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), home = homedir(), color = false } = options;
  const paint = (symbol: "✓" | "✗") => (color ? `\u001b[${symbol === "✓" ? "38;2;74;222;128" : "38;2;217;45;32"}m${symbol}\u001b[0m` : symbol);
  const names = Object.fromEntries(Object.entries(options.names ?? {}).map(([address, name]) => [normalizeServerUrl(/^https?:\/\//.test(address) ? address : `https://${address}`), name]));
  const shown = (path: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

  const legacy = readLogins(configDir);
  const installed = listInstallations(configDir);
  if (legacy.length === 0) {
    out(installed.length === 0 ? "Nothing to migrate: this computer has no old installation." : `Nothing to migrate: ${plural(installed.length, "instance")} ${installed.length === 1 ? "is" : "are"} already installed (${installed.map((installation) => installation.name).join(", ")}).`);
    return { migrated: 0, left: 0 };
  }

  const taken = new Map(installed.map((installation) => [installation.id, installation.serverUrl]));
  const alreadyThere = (login: Login) => installed.some((installation) => normalizeServerUrl(installation.serverUrl) === normalizeServerUrl(login.serverUrl));
  const planned: Planned[] = [];
  const problems: { label: string; address: string; serverUrl: string; text: string[] }[] = [];
  const stays: Login[] = [];
  for (const login of legacy) {
    const serverUrl = normalizeServerUrl(login.serverUrl);
    if (alreadyThere(login)) continue;
    const label = fallbackName(serverUrl);
    let info: InstanceInfo;
    try {
      info = await deps.fetchInstance(serverUrl, login.token);
    } catch (error) {
      problems.push({ label, address: addressOf(serverUrl), serverUrl, text: [`cannot use it with this token (${(error as Error).message}).`, "Left in the old login. Run redline setup <address> once it answers, or redline migrate again."] });
      stays.push(login);
      continue;
    }
    const chosen = names[serverUrl];
    const name = chosen ?? info.instanceName ?? (label === "localhost" || label === "" ? "Local" : label);
    const id = installationId(name);
    const owner = taken.get(id);
    if (!id || owner) {
      problems.push({
        label: name,
        address: addressOf(serverUrl),
        serverUrl,
        text: [id ? `the name "${id}" is already taken by ${addressOf(owner!)}.` : `"${name}" cannot make a folder name.`, `Left in the old login. Run redline migrate --name ${serverUrl}=<name>.`],
      });
      stays.push(login);
      continue;
    }
    taken.set(id, serverUrl);
    planned.push({ login, serverUrl, name, nameChosen: chosen !== undefined });
  }

  const registered = existingAgents(configDir, await host?.agents());
  let stoppedAgents = 0;
  if (host && planned.length > 0) {
    const nameOf = (serverUrl: string) => planned.find((entry) => entry.serverUrl === normalizeServerUrl(serverUrl))?.name ?? addressOf(serverUrl);
    const running = (agents: HostAgent[]) => agents.filter((agent) => agent.state === "running");
    if (!now) {
      let runs = running(await host.agents());
      if (runs.length > 0) {
        const describe = (agent: HostAgent) => `${agent.name} on ${nameOf(agent.serverUrl)}${agent.projectNames?.length ? ` · ${agent.projectNames.join(", ")}` : ""}${agent.run ? ` › ${agent.run.page}` : ""}`;
        out(`Waiting for ${plural(runs.length, "run")} to finish: ${runs.map(describe).join("; ")} (--now stops ${runs.length === 1 ? "it" : "them"})…`);
        while (runs.length > 0) {
          await sleep(1000);
          runs = running(await host.agents());
        }
      }
    }
    const agents = await host.agents();
    for (const agent of agents.filter((entry) => entry.state !== "stopped")) {
      await host.stop(agent.id, MIGRATE_STOP_REASON);
      stoppedAgents += 1;
    }
    out(`Stopped the agent host (${plural(agents.length, "agent")}).`);
    await host.untilGone();
  }

  const moved: Planned[] = [];
  const lines: { symbol: "✓" | "✗"; label: string; address: string; rest: string[] }[] = [];
  for (const entry of planned) {
    try {
      const installation = await createInstallation({ configDir, id: installationId(entry.name), serverUrl: entry.serverUrl, token: entry.login.token, name: entry.name, nameChosen: entry.nameChosen, deps });
      const count = registered.filter((agent) => normalizeServerUrl(agent.serverUrl) === entry.serverUrl).length;
      moved.push(entry);
      lines.push({ symbol: "✓", label: entry.name, address: addressOf(entry.serverUrl), rest: [`→ ${shown(installation.dir)}   token moved${count > 0 ? ` · ${plural(count, "agent")}` : ""}`] });
    } catch (error) {
      stays.push(entry.login);
      lines.push({ symbol: "✗", label: entry.name, address: addressOf(entry.serverUrl), rest: [`could not install its build: ${(error as Error).message.replace(/\.$/, "")}.`, "Left in the old login. Run redline migrate again once the server is up."] });
    }
  }
  replaceLogins(configDir, stays);

  const all = [...lines.map((line) => ({ ...line, ok: line.symbol === "✓" })), ...problems.map((problem) => ({ symbol: "✗" as const, label: problem.label, address: problem.address, rest: problem.text, ok: false }))];
  // Successes first, in the order of the old login, then the servers left behind.
  const labelWidth = Math.max(0, ...all.map((line) => line.label.length));
  const addressWidth = Math.max(0, ...all.map((line) => line.address.length)) + 3;
  for (const line of all) {
    const head = `${paint(line.symbol)} ${line.label.padEnd(labelWidth)}  `;
    if (line.ok) out(`${head}${line.address.padEnd(addressWidth)}${line.rest[0]}`);
    else {
      out(`${head}${line.address}: ${line.rest[0]}`);
      for (const extra of line.rest.slice(1)) out(`${" ".repeat(labelWidth + 4)}${extra}`);
    }
  }

  if (moved.length > 0) {
    const mcp = await deps.registerMcp();
    out(mcp === "claude-missing" ? `${paint("✗")} Claude Code is not installed. Install it (https://docs.claude.com/claude-code), then run redline setup again.` : `${paint("✓")} Claude Code: the redline MCP now starts the installation of each folder's instance.`);
  }
  const total = moved.length + stays.length;
  if (stays.length > 0) out(`Migrated ${moved.length} of ${total} instances. Other commands still refuse until every server is migrated.`);
  else out(`Migrated ${plural(moved.length, "instance")}. In open Claude Code sessions, type /mcp and reconnect redline${stoppedAgents > 0 ? "; then redline and R restarts the agents" : ""}.`);
  return { migrated: moved.length, left: stays.length };
}

/** The host's agents when it runs, else those of the registry file. */
function existingAgents(configDir: string, fromHost: HostAgent[] | undefined): HostAgent[] {
  return fromHost ?? new AgentRegistry(configDir).load(new Date().toISOString()).agents;
}
