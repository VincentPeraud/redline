import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_API_PREFIX, CLI_TARBALL_PATH, HOST_PROTOCOL_VERSION, type RedlineInstanceResponse } from "@redline/shared";
import { cliVersion } from "./build-hash.js";
import { agentsOfInstallation, removeStoppedAgents, restartInstallationAgents, restartStoppedAgents } from "./installation-agents.js";
import type { DoctorDeps, McpRegistration } from "./doctor.js";
import { HostClient } from "./host-client.js";
import { hostProtocol } from "./host-protocol.js";
import { listProjects } from "./link.js";
import { npmInstall } from "./install-cli.js";
import type { InstallationsDeps, InstanceInfo, McpStatus, SetupResult } from "./installations.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { ServerApi } from "./server-api.js";

interface ClaudeResult {
  ok: boolean;
  missing: boolean;
  stdout: string;
}

function claude(args: string[], env: NodeJS.ProcessEnv): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    execFile("claude", args, { env }, (error, stdout) => {
      resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT", stdout });
    });
  });
}

/** Whether Claude Code already has the user-scope `redline` entry running `redline mcp`. */
function isRegistered(output: string): boolean {
  return /Scope:\s*User/i.test(output) && /Command:\s*redline\s*$/im.test(output) && /Args:\s*mcp\s*$/im.test(output);
}

/** Registers `redline mcp` in Claude Code at user scope; an identical entry is left alone, a different one replaced. */
export async function registerMcp(env: NodeJS.ProcessEnv): Promise<McpStatus> {
  const existing = await claude(["mcp", "get", "redline"], env);
  if (existing.missing) return "claude-missing";
  if (existing.ok && isRegistered(existing.stdout)) return "already";
  if (existing.ok) await claude(["mcp", "remove", "--scope", "user", "redline"], env);
  const added = await claude(["mcp", "add", "--scope", "user", "redline", "--", "redline", "mcp"], env);
  if (!added.ok) throw new Error("`claude mcp add` failed. Run it yourself: claude mcp add --scope user redline -- redline mcp");
  return "registered";
}

/** What Claude Code has registered as `redline` (user scope), for doctor. */
export async function mcpRegistration(env: NodeJS.ProcessEnv): Promise<McpRegistration> {
  const existing = await claude(["mcp", "get", "redline"], env);
  if (existing.missing) return { status: "claude-missing" };
  if (!existing.ok) return { status: "absent" };
  if (isRegistered(existing.stdout)) return { status: "registered" };
  const command = /Command:\s*(.+)$/im.exec(existing.stdout)?.[1]?.trim() ?? "";
  const args = /Args:\s*(.*)$/im.exec(existing.stdout)?.[1]?.trim() ?? "";
  return { status: "other", command: `${command} ${args}`.trim() };
}

/** The server's own description of itself; an older server has no such route, and then only the token is checked. */
async function fetchInstance(serverUrl: string, token: string): Promise<InstanceInfo> {
  let answer: Response;
  try {
    answer = await fetch(`${serverUrl}${AGENT_API_PREFIX}/instance`, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
  } catch (error) {
    throw new Error(`cannot reach it (${(error as Error).message})`);
  }
  if (answer.status === 401) throw new Error("the server refused it");
  if (answer.status === 404) {
    await new ServerApi(serverUrl, token).listProjects();
    return {};
  }
  if (!answer.ok) throw new Error(`the server answered ${answer.status}`);
  const { redlineInstanceName, version, buildHash, hostProtocol } = (await answer.json()) as Partial<RedlineInstanceResponse>;
  return { redlineInstanceName, version, buildHash, hostProtocol };
}

/** Downloads the tarball the server serves, then installs it under the prefix. */
async function install(serverUrl: string, prefix: string): Promise<void> {
  const url = `${serverUrl}${CLI_TARBALL_PATH}`;
  const answer = await fetch(url).catch((error: Error) => {
    throw new Error(`${url} cannot be reached (${error.message})`);
  });
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`);
  const folder = mkdtempSync(join(tmpdir(), "redline-cli-"));
  try {
    const tarball = join(folder, "redline-cli.tgz");
    writeFileSync(tarball, Buffer.from(await answer.arrayBuffer()));
    await npmInstall(tarball, prefix);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The real servers, Claude Code and host, for `redline doctor`. */
export function systemDoctorDeps(configDir: string, env: NodeJS.ProcessEnv = process.env): DoctorDeps {
  const { fetchInstance: fetchOne, commandVersion, hostProtocol: protocol } = systemDeps(configDir, env);
  return {
    fetchInstance: fetchOne,
    commandVersion,
    hostProtocol: protocol,
    mcp: () => mcpRegistration(env),
    async host() {
      let host: HostClient;
      try {
        host = await HostClient.connect(configDir, env);
      } catch {
        return { running: false };
      }
      try {
        return { running: true, agents: (await host.list()).filter((agent) => agent.state !== "stopped").length };
      } finally {
        host.close();
      }
    },
    async projectNames({ serverUrl, token }, ids) {
      return (await listProjects({ serverUrl, token }, true)).filter((project) => ids.includes(project.id)).map((project) => sanitizeForTerminal(project.title));
    },
  };
}

/** The real npm, Claude Code, server and host. */
export function systemDeps(configDir: string, env: NodeJS.ProcessEnv = process.env): InstallationsDeps {
  return {
    fetchInstance,
    install,
    registerMcp: () => registerMcp(env),
    restartStoppedAgents: (serverUrl) => restartStoppedAgents(configDir, serverUrl, env),
    installGlobalCommand: (serverUrl) => npmInstall(`${serverUrl}${CLI_TARBALL_PATH}`, undefined),
    restartAgents: (installation) => restartInstallationAgents(configDir, installation, env),
    agentsOf: (installation) => agentsOfInstallation(configDir, installation, env),
    removeStoppedAgents: (installation) => removeStoppedAgents(configDir, installation, env),
    commandVersion: cliVersion(),
    hostProtocol: HOST_PROTOCOL_VERSION,
    oldestAccepted: hostProtocol(cliVersion()).oldestRelease ?? "",
  };
}

export const STYLES = { bold: "1", muted: "38;2;161;161;170", green: "38;2;74;222;128", amber: "38;2;251;191;36", red: "38;2;217;45;32" } as const;

/** The lines `redline setup` prints for a finished setup (texts of the setup.html mock-up); `color` paints them for a terminal. */
export function setupReport(
  { installation, created, mcp, tooOld, restarted }: SetupResult,
  { deps, color = false, home = homedir() }: { deps: Pick<InstallationsDeps, "commandVersion" | "oldestAccepted">; color?: boolean; home?: string },
): string[] {
  const paint = (style: keyof typeof STYLES, text: string) => (color ? `\u001b[${STYLES[style]}m${text}\u001b[0m` : text);
  const shown = (path: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);
  const lines: string[] = [];
  if (created) {
    const address = installation.serverUrl.replace(/^https?:\/\//, "");
    lines.push(`${paint("green", "✓ ")}${paint("bold", installation.name)}${paint("muted", ` · ${address}${installation.version ? ` · v${installation.version}` : ""}`)}`);
    lines.push(paint("muted", `  Installed in ${shown(installation.dir)}`));
  } else {
    lines.push(`${paint("green", "✓ ")}${paint("bold", installation.name)}: token replaced (name and build kept).`);
    if (restarted.length > 0) lines.push(`  Restarted ${restarted.length} agent${restarted.length === 1 ? "" : "s"} stopped by the old token: ${restarted.join(", ")}.`);
  }
  if (mcp === "registered") {
    lines.push(`${paint("green", "✓ ")}Claude Code: registered the ${paint("bold", "redline")} MCP for every session. In a folder linked to ${installation.name}, it runs this installation.`);
    if (created) lines.push(`  Next: ${paint("bold", "redline link")} in a project folder, or ${paint("bold", "redline agent")} to start an agent there.`);
  } else if (mcp === "already" && created) {
    lines.push(`  Claude Code: the ${paint("bold", "redline")} MCP is already registered.`);
  } else if (mcp === "claude-missing") {
    lines.push(paint("red", "✗ ") + paint("red", "Claude Code is not installed. Install it (https://docs.claude.com/claude-code), then run redline setup again."));
  }
  if (tooOld) {
    lines.push(paint("amber", `! v${installation.version} is too old for this redline command (v${deps.commandVersion}, accepts v${deps.oldestAccepted} and later):`));
    lines.push(paint("muted", `  its agents will be refused until ${installation.name}'s server is upgraded. Its MCP works.`));
  }
  return lines;
}
