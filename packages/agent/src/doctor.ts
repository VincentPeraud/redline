import { homedir } from "node:os";
import { join } from "node:path";
import { hostProtocol as protocolOf, acceptsProtocol } from "./host-protocol.js";
import {
  addressOf,
  hasLegacyLayout,
  isOlder,
  listInstallations,
  resolveFolder,
  skippedInstallationFolders,
  type Installation,
  type InstallationsDeps,
  type InstanceInfo,
} from "./installations.js";
import { readLogins } from "./login.js";
import { STYLES } from "./setup.js";

/**
 * `redline doctor` as two steps: `gatherDoctor` asks the world (servers, Claude Code, host, folder), `doctorReport` turns the
 * gathered state into the lines of the doctor.html / doctor-etats.html mock-ups, with no side effect. The per-installation
 * diagnosis (`diagnoseInstallation`) is exported on its own: the Instances tab shows the same state, text and fix.
 */

export type InstallationState = "up-to-date" | "update-available" | "too-old" | "token-refused" | "unreachable";
/** `ok` is a green check, `warning` an amber "!", `problem` a red cross. */
export type Severity = "ok" | "warning" | "problem";

/** The command that fixes a problem, with the words before it: printed as `→ <before><command>`. */
export interface Fix {
  before: string;
  command: string;
}

export interface InstallationDiagnosis {
  state: InstallationState;
  severity: Severity;
  /** What follows the address on the installation's line. */
  status: string;
  /** Absent when nothing is wrong. */
  fix?: Fix;
}

/** What asking an installation's server returned: its answer, or why there is none. */
export interface InstallationProbe {
  installation: Pick<Installation, "id" | "name" | "serverUrl" | "version" | "buildHash" | "hostProtocol">;
  info?: InstanceInfo;
  failure?: "token-refused" | "unreachable";
}

const shortHash = (hash: string) => hash.slice(0, 7);

/** The diagnosis of one installation against its server and against the global command (`commandVersion`, `hostProtocol` of this command). */
export function diagnoseInstallation({ installation, info, failure }: InstallationProbe, { commandVersion, hostProtocol }: { commandVersion: string; hostProtocol: number }): InstallationDiagnosis {
  const own = `v${installation.version ?? "?"}`;
  if (failure === "token-refused") {
    return {
      state: "token-refused",
      severity: "problem",
      status: "token refused (regenerated, or account deactivated)",
      fix: { before: `copy your token from ${installation.name}'s Agents page (Lancer un agent), then `, command: `redline setup ${installation.serverUrl}` },
    };
  }
  if (failure === "unreachable" || !info) {
    return { state: "unreachable", severity: "problem", status: "cannot reach the server", fix: { before: "check the address, or ", command: `redline remove ${installation.id}` } };
  }
  const update = { before: "", command: `redline update ${installation.id}` };
  const protocol = protocolOf(commandVersion, hostProtocol);
  if (!acceptsProtocol(protocol, installation.hostProtocol)) {
    const accepted = protocol.oldestRelease ? `v${protocol.oldestRelease}` : `host protocol ${protocol.oldest}`;
    const serverReady = acceptsProtocol(protocol, info.hostProtocol);
    const server = info.version ? `the server runs v${info.version}: it` : "its server";
    return {
      state: "too-old",
      severity: "problem",
      status: `${own}, too old for this command (accepts ${accepted} and later)`,
      fix: serverReady ? update : { before: `${server} must be upgraded, then `, command: update.command },
    };
  }
  const server = info.version;
  const sameVersion = server === installation.version;
  const otherBuild = installation.buildHash !== undefined && info.buildHash !== undefined && installation.buildHash !== info.buildHash;
  const newer = server !== undefined && installation.version !== undefined && isOlder(installation.version, server);
  if (newer || (sameVersion && otherBuild)) {
    const hashes = sameVersion && otherBuild;
    const installed = hashes ? `${own} (${shortHash(installation.buildHash!)})` : own;
    const served = `v${server}${hashes ? ` (${shortHash(info.buildHash!)})` : ""}`;
    return { state: "update-available", severity: "warning", status: `${installed} installed, the server runs ${served}`, fix: update };
  }
  return { state: "up-to-date", severity: "ok", status: `${own} · up to date · token OK` };
}

export type McpRegistration = { status: "registered" } | { status: "other"; command: string } | { status: "absent" } | { status: "claude-missing" };
export type HostState = { running: false } | { running: true; agents: number };

export interface DoctorDeps extends Pick<InstallationsDeps, "fetchInstance" | "commandVersion" | "hostProtocol"> {
  mcp(): Promise<McpRegistration>;
  host(): Promise<HostState>;
  /** Names of the projects the folder's link lists, on that installation. */
  projectNames(installation: Installation, ids: string[]): Promise<string[]>;
  /** Longest wait for a server's answer. */
  timeoutMs?: number;
}

export type FolderState =
  | { kind: "linked"; name: string; projects: string[]; viaLink: boolean }
  | { kind: "orphan"; serverUrl: string }
  /** `installed`: how many installations exist, to tell which command fixes it. */
  | { kind: "unlinked"; installed: number };

export type DoctorState =
  | { kind: "legacy"; servers: number; file: string }
  | {
      kind: "report";
      commandVersion: string;
      hostProtocol: number;
      host: HostState;
      mcp: McpRegistration;
      probes: InstallationProbe[];
      skipped: string[];
      folder: { path: string } & FolderState;
    };

const refused = (error: unknown) => /refused/i.test((error as Error).message);

/** What reaching an installation's server needs. */
export type ProbeDeps = Pick<DoctorDeps, "fetchInstance" | "timeoutMs">;

export async function probe(installation: Installation, deps: ProbeDeps): Promise<InstallationProbe> {
  const answer = await Promise.race([
    deps.fetchInstance(installation.serverUrl, installation.token).then((info): Pick<InstallationProbe, "info" | "failure"> => ({ info })),
    new Promise<Pick<InstallationProbe, "failure">>((resolve) => setTimeout(() => resolve({ failure: "unreachable" }), deps.timeoutMs ?? 5000).unref()),
  ]).catch((error): Pick<InstallationProbe, "failure"> => ({ failure: refused(error) ? "token-refused" : "unreachable" }));
  return { installation, ...answer };
}

export async function gatherDoctor({ configDir, folder, deps }: { configDir: string; folder: string; deps: DoctorDeps }): Promise<DoctorState> {
  if (hasLegacyLayout(configDir)) return { kind: "legacy", servers: readLogins(configDir).length, file: join(configDir, "login.json") };
  const installations = listInstallations(configDir);
  const [probes, mcp, host] = await Promise.all([Promise.all(installations.map((installation) => probe(installation, deps))), deps.mcp(), deps.host()]);
  const resolution = resolveFolder(configDir, folder);
  let state: FolderState;
  if (resolution.kind === "orphan") state = { kind: "orphan", serverUrl: resolution.serverUrl };
  else if (resolution.kind === "unlinked") state = { kind: "unlinked", installed: resolution.installations.length };
  else {
    const reachable = probes.find((candidate) => candidate.installation.id === resolution.installation.id)?.failure === undefined;
    const projects = resolution.root && resolution.projectIds.length > 0 && reachable ? await deps.projectNames(resolution.installation, resolution.projectIds).catch(() => []) : [];
    state = { kind: "linked", name: resolution.installation.name, projects, viaLink: resolution.root !== undefined };
  }
  return { kind: "report", commandVersion: deps.commandVersion, hostProtocol: deps.hostProtocol, host, mcp, probes, skipped: skippedInstallationFolders(configDir), folder: { path: folder, ...state } };
}

export interface DoctorReport {
  lines: string[];
  problems: number;
  warnings: number;
}

/** The lines `redline doctor` prints (texts of doctor.html and doctor-etats.html); `color` paints them for a terminal. */
export function doctorReport(state: DoctorState, { color = false, home = homedir() }: { color?: boolean; home?: string } = {}): DoctorReport {
  const paint = (style: keyof typeof STYLES | "heading", text: string) => {
    const code = style === "heading" ? `1;${STYLES.muted}` : STYLES[style];
    return color ? `\u001b[${code}m${text}\u001b[0m` : text;
  };
  const shown = (path: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const arrow = (indent: string, before: string, command: string, after = "") => `${indent}${paint("muted", `→ ${before}`)}${paint("bold", command)}${after ? paint("muted", after) : ""}`;

  if (state.kind === "legacy") {
    return {
      lines: [
        paint("red", "✗ ") + paint("red", `Old installation: one login for ${state.servers} server${state.servers === 1 ? "" : "s"} (${shown(state.file)}).`),
        arrow("  ", "", "redline migrate", " (every other command refuses until then)"),
      ],
      problems: 1,
      warnings: 0,
    };
  }

  let problems = 0;
  let warnings = 0;
  const lines: string[] = [];
  const host = state.host.running ? `agent host v${state.commandVersion}, running (${state.host.agents} agent${state.host.agents === 1 ? "" : "s"})` : "agent host not running";
  lines.push(paint("bold", "redline") + paint("muted", ` command v${state.commandVersion} · ${host}`));

  const setupAgain = () => arrow("  ", "", "redline setup <address>", " of any installed instance registers it again");
  if (state.mcp.status === "registered") {
    lines.push(`${paint("green", "✓ ")}Claude Code: the ${paint("bold", "redline")} MCP is registered for every session.`);
  } else if (state.mcp.status === "other") {
    problems += 1;
    lines.push(paint("red", "✗ ") + paint("red", `Claude Code: the redline MCP runs another command (${state.mcp.command}).`), setupAgain());
  } else if (state.mcp.status === "absent") {
    problems += 1;
    lines.push(paint("red", "✗ ") + paint("red", "Claude Code: the redline MCP is not registered."), arrow("  ", "", "redline setup <address>", " of any installed instance registers it"));
  } else {
    problems += 1;
    lines.push(paint("red", "✗ ") + paint("red", "Claude Code is not installed: the redline MCP cannot be registered."));
  }

  lines.push("", paint("heading", "INSTANCES"));
  const rows = state.probes.map((entry) => ({ entry, diagnosis: diagnoseInstallation(entry, { commandVersion: state.commandVersion, hostProtocol: state.hostProtocol }) }));
  const skipped = state.skipped.map((id) => ({ name: id, address: `instances/${id}` }));
  const nameWidth = Math.max(0, ...rows.map(({ entry }) => entry.installation.name.length), ...skipped.map(({ name }) => name.length)) + 2;
  const addressWidth = Math.max(0, ...rows.map(({ entry }) => addressOf(entry.installation.serverUrl).length), ...skipped.map(({ address }) => address.length)) + 4;
  const indent = " ".repeat(2 + nameWidth + addressWidth);
  if (rows.length === 0 && skipped.length === 0) lines.push(paint("muted", "○ No instance is set up on this computer."), arrow("  ", "", "redline setup <address>"));
  for (const { entry, diagnosis } of rows) {
    if (diagnosis.severity === "problem") problems += 1;
    if (diagnosis.severity === "warning") warnings += 1;
    const icon = { ok: paint("green", "✓ "), warning: paint("amber", "! "), problem: paint("red", "✗ ") }[diagnosis.severity];
    const status = { ok: diagnosis.status, warning: paint("amber", diagnosis.status), problem: paint("red", diagnosis.status) }[diagnosis.severity];
    lines.push(`${icon}${paint("bold", entry.installation.name.padEnd(nameWidth))}${paint("muted", addressOf(entry.installation.serverUrl).padEnd(addressWidth))}${status}`);
    if (diagnosis.fix) lines.push(arrow(indent, diagnosis.fix.before, diagnosis.fix.command));
  }
  for (const { name, address } of skipped) {
    lines.push(`${paint("muted", "○ ")}${paint("bold", name.padEnd(nameWidth))}${paint("muted", `${address.padEnd(addressWidth)}skipped: not an installation (no login, no build)`)}`);
  }

  lines.push("", paint("heading", "THIS FOLDER"));
  const { folder } = state;
  const path = shown(folder.path);
  if (folder.kind === "linked" && folder.viaLink) {
    const projects = folder.projects.length > 0 ? `${folder.projects.map((name) => paint("bold", name)).join(", ")} on ` : "";
    lines.push(`${paint("green", "✓ ")}${path} → ${projects}${paint("bold", folder.name)}`);
  } else if (folder.kind === "linked") {
    lines.push(`${paint("green", "✓ ")}${path} uses ${paint("bold", folder.name)}, the only installation (no link needed)`);
  } else if (folder.kind === "orphan") {
    problems += 1;
    const address = addressOf(folder.serverUrl);
    lines.push(paint("red", "✗ ") + paint("red", `${path} → ${address}, not installed on this computer`));
    lines.push(`  ${paint("muted", "→ ")}${paint("bold", `redline setup ${/^https?:\/\//.test(folder.serverUrl) ? folder.serverUrl : `https://${address}`}`)}${paint("muted", ", or ")}${paint("bold", "redline link <instance>")}`);
  } else {
    lines.push(paint("muted", "○ ") + paint("muted", `${path} is linked to no instance: Claude Code sessions here do not see Redline`));
    lines.push(arrow("  ", "", folder.installed === 0 ? "redline setup <address>" : "redline link"));
  }

  const counts = [problems > 0 && `${problems} problem${problems === 1 ? "" : "s"}`, warnings > 0 && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean);
  lines.push("", counts.length > 0 ? paint("amber", `${counts.join(", ")}.`) : paint("green", "✓ No problem found."));
  return { lines, problems, warnings };
}
