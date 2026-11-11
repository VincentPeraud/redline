import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redlineInstanceFallbackName, redlineInstanceHandle } from "@redline/shared";
import { acceptsProtocol, hostProtocol } from "./host-protocol.js";
import { findLink } from "./link.js";
import { receivedInstanceName } from "./sanitize.js";
import { normalizeServerUrl, readLogins, validateServerUrl, type Login } from "./login.js";

/**
 * One installation per Redline instance, in a folder of its own: `<configDir>/instances/<id>/` holds `login.json` (address,
 * token, display name; mode 0600) and `npm/`, the npm prefix of the build the instance's server serves. Nothing is shared.
 * The old single `<configDir>/login.json` is the "legacy layout" that `migrate` replaces.
 */
export interface Installation {
  /** Fixed at creation, derived from the name: also the folder name. */
  id: string;
  /** Display name. Kept as is when `nameChosen`, otherwise it follows the server's instance name. */
  name: string;
  nameChosen: boolean;
  serverUrl: string;
  token: string;
  dir: string;
  /** npm prefix of the installed build. */
  prefix: string;
  /** `dist/cli.js` of the installed build. */
  entry: string;
  /** Version of the installed build; absent when it cannot be read. */
  version?: string;
  buildHash?: string;
  /** Host protocol version the installed build speaks; absent for a build older than the installations. */
  hostProtocol?: number;
}

/** What the server tells about itself (`GET /agent-api/instance`); an old server tells nothing. */
export interface InstanceInfo {
  redlineInstanceName?: string;
  version?: string;
  buildHash?: string;
  /** Host protocol of the CLI build the server serves. */
  hostProtocol?: number;
}

export type McpStatus = "registered" | "already" | "claude-missing";

/** The side effects of the installations module: injected, so that tests run without npm, Claude Code, a server or a host. */
export interface InstallationsDeps {
  /** Asks the server about itself with the token; throws when the token is refused or the server cannot be reached. */
  fetchInstance(serverUrl: string, token: string): Promise<InstanceInfo>;
  /** Installs the build the server serves (`<serverUrl>/cli/redline-cli.tgz`) under the npm prefix; rejects with why it failed. */
  install(serverUrl: string, prefix: string): Promise<void>;
  /** Registers the global `redline mcp` in Claude Code at user scope, unless it is already. */
  registerMcp(): Promise<McpStatus>;
  /** Restarts the agents of that address that the host stopped because their token was refused; returns their names. */
  restartStoppedAgents(serverUrl: string): Promise<string[]>;
  /** `npm i -g` of the build `serverUrl` serves: refreshes the global `redline` command. */
  installGlobalCommand(serverUrl: string): Promise<void>;
  /** Tells the host the installation was updated: its agents restart, each after its run. Returns the names of those that will (none when no host runs). */
  restartAgents(installation: Installation): Promise<string[]>;
  /** The host's agents of this installation (`running` is anything but stopped); the saved ones, all stopped, when no host runs. */
  agentsOf(installation: Installation): Promise<{ name: string; running: boolean; folder?: string }[]>;
  /** Removes the installation's stopped agents from the host (or from the saved list when no host runs); returns their names. */
  removeStoppedAgents(installation: Installation): Promise<string[]>;
  /** Version of this redline command. */
  commandVersion: string;
  /** Host protocol version of this command: an installation more than one version behind gets a warning, its agents are refused. */
  hostProtocol: number;
  /** First release speaking the oldest protocol this command accepts, for the warning. */
  oldestAccepted: string;
}

export const INSTALLATIONS_FOLDER = "instances";

export const installationsPath = (configDir: string) => join(configDir, INSTALLATIONS_FOLDER);

/** Where npm puts a package installed globally under `prefix`. */
export const installedPackageDir = (prefix: string): string =>
  process.platform === "win32" ? join(prefix, "node_modules", "redline-cli") : join(prefix, "lib", "node_modules", "redline-cli");

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function installedBuild(prefix: string): { version?: string; buildHash?: string; hostProtocol?: number } {
  const dir = installedPackageDir(prefix);
  let version: string | undefined;
  try {
    version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;
  } catch {
    // no readable package.json: the version stays unknown
  }
  const protocol = Number.parseInt(readText(join(dir, "host-protocol.txt")) ?? "", 10);
  return { version, buildHash: readText(join(dir, "build-hash.txt")), hostProtocol: Number.isInteger(protocol) ? protocol : undefined };
}

interface StoredLogin {
  serverUrl: string;
  token: string;
  name: string;
  nameChosen: boolean;
}

function readInstallation(configDir: string, id: string): Installation | undefined {
  const dir = join(installationsPath(configDir), id);
  let stored: Partial<StoredLogin>;
  try {
    stored = JSON.parse(readFileSync(join(dir, "login.json"), "utf8")) as Partial<StoredLogin>;
  } catch {
    return undefined;
  }
  if (typeof stored.serverUrl !== "string" || typeof stored.token !== "string" || typeof stored.name !== "string") return undefined;
  const prefix = join(dir, "npm");
  return {
    id,
    name: stored.name,
    nameChosen: stored.nameChosen === true,
    serverUrl: stored.serverUrl,
    token: stored.token,
    dir,
    prefix,
    entry: join(installedPackageDir(prefix), "dist", "cli.js"),
    ...installedBuild(prefix),
  };
}

/** Every installation on this computer, by id. Folders being built (dot-prefixed) and unreadable ones are left out. */
export function listInstallations(configDir: string): Installation[] {
  let ids: string[];
  try {
    ids = readdirSync(installationsPath(configDir)).filter((id) => !id.startsWith(".")).sort();
  } catch {
    return [];
  }
  return ids.flatMap((id) => readInstallation(configDir, id) ?? []);
}

/** Folders under the installations dir that are not installations (no readable login): doctor reports them, nothing uses them. */
export function skippedInstallationFolders(configDir: string): string[] {
  try {
    return readdirSync(installationsPath(configDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !readInstallation(configDir, entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** By id, name (compared as an id) or address (compared normalized). */
export function findInstallation(configDir: string, wanted: string): Installation | undefined {
  const address = normalizeServerUrl(wanted);
  const id = redlineInstanceHandle(wanted);
  return listInstallations(configDir).find((installation) => installation.serverUrl === address || installation.id === id);
}

/**
 * The installation `--instance <name|address>` (or its alias `--server`) names, or the only one set up. The address may be written
 * with or without its scheme.
 */
export function pickInstallation(configDir: string, wanted?: string): Installation {
  const all = listInstallations(configDir);
  if (wanted) {
    const id = redlineInstanceHandle(wanted);
    const bare = normalizeServerUrl(wanted).replace(/^https?:\/\//, "");
    const found = all.find((installation) => installation.id === id || normalizeServerUrl(installation.serverUrl).replace(/^https?:\/\//, "") === bare);
    if (!found) throw new Error(`${wanted} is not set up. Run \`redline setup ${wanted}\` first.`);
    return found;
  }
  if (all.length === 0) throw new Error("No Redline instance is set up. Run `redline setup <address>` first.");
  if (all.length > 1) throw new Error(`Several Redline instances are set up (${all.map((installation) => installation.name).join(", ")}): pass --instance <name|address>.`);
  return all[0];
}

/** The old single login is still there: every command but `migrate` refuses. */
export const hasLegacyLayout = (configDir: string): boolean => existsSync(join(configDir, "login.json")) && readLogins(configDir).length > 0;

/** The logins of the installations, for the code that still speaks in `Login`s. */
export const installationLogins = (configDir: string): Login[] => listInstallations(configDir).map(({ serverUrl, token }) => ({ serverUrl, token }));

export type FolderResolution =
  /** `root` is the folder holding the link; absent when the only installation was taken for a folder with no usable link. */
  | { kind: "linked"; installation: Installation; root?: string; projectIds: string[] }
  | { kind: "orphan"; serverUrl: string; root: string }
  /** Several installations (or none) and no usable link. */
  | { kind: "unlinked"; installations: Installation[] };

/**
 * The installation a folder uses: the one its nearest link (here or in a parent) names, a link to an address that is not
 * installed here, or the only installation when the folder has no usable link. An old link without an address is no link.
 * Nothing is ever rewritten.
 */
export function resolveFolder(configDir: string, folder: string): FolderResolution {
  const installations = listInstallations(configDir);
  const found = findLink(folder);
  if (found?.link.serverUrl) {
    const wanted = normalizeServerUrl(found.link.serverUrl);
    const installation = installations.find((candidate) => normalizeServerUrl(candidate.serverUrl) === wanted);
    return installation ? { kind: "linked", installation, root: found.root, projectIds: found.link.projectIds } : { kind: "orphan", serverUrl: found.link.serverUrl, root: found.root };
  }
  return installations.length === 1 ? { kind: "linked", installation: installations[0], projectIds: [] } : { kind: "unlinked", installations };
}

/** The address as people read it: no scheme. */
export const addressOf = (serverUrl: string): string => serverUrl.replace(/^https?:\/\//, "");

export interface InstanceLabel {
  name: string;
  address: string;
  version?: string;
}

/** First line of every MCP answer: where Claude publishes. */
export const instanceLine = ({ name, address, version }: InstanceLabel): string => `Instance: ${name} (${address}${version ? `, v${version}` : ""})`;

/**
 * The display name of an installation now: the name given at setup is kept, otherwise the server's instance name wins.
 * The server being unreachable (or slow) leaves the stored name. A new name is stored, so that lists elsewhere show it too.
 */
export async function currentInstallation(configDir: string, installation: Installation, fetchInstance: InstallationsDeps["fetchInstance"], timeoutMs = 3000): Promise<Installation> {
  if (installation.nameChosen) return installation;
  const timeout = new Promise<InstanceInfo>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref());
  const info = await Promise.race([fetchInstance(installation.serverUrl, installation.token), timeout]).catch(() => undefined);
  const name = info?.redlineInstanceName && receivedInstanceName(info.redlineInstanceName);
  if (!name || name === installation.name) return installation;
  writeLogin(installation.dir, { serverUrl: installation.serverUrl, token: installation.token, name, nameChosen: false });
  return { ...installation, name };
}

function writeLogin(dir: string, stored: StoredLogin): void {
  const file = join(dir, "login.json");
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created: tighten one that already existed.
  chmodSync(file, 0o600);
}

/** Installs the build and writes the login in a folder of its own, then moves it into place: nothing is left behind when it fails. */
export async function createInstallation({ configDir, id, serverUrl, token, name, nameChosen, deps }: { configDir: string; id: string; serverUrl: string; token: string; name: string; nameChosen: boolean; deps: Pick<InstallationsDeps, "install"> }): Promise<Installation> {
  const root = installationsPath(configDir);
  mkdirSync(root, { recursive: true });
  const building = join(root, `.${id}-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(building);
    await deps.install(serverUrl, join(building, "npm"));
    writeLogin(building, { serverUrl, token, name, nameChosen });
    renameSync(building, join(root, id));
  } catch (error) {
    rmSync(building, { recursive: true, force: true });
    throw error;
  }
  return readInstallation(configDir, id)!;
}

/** A refusal with a message meant to be printed as is (second lines indented by two spaces). */
export class SetupRefusal extends Error {}

/** The address as stored, or a refusal (http:// outside this computer...). Setup checks it before asking for the token. */
export function checkedAddress(serverUrl: string): string {
  try {
    return validateServerUrl(serverUrl);
  } catch (error) {
    throw new SetupRefusal((error as Error).message);
  }
}

export interface SetupOptions {
  configDir: string;
  serverUrl: string;
  token: string;
  /** `--name`. */
  name?: string;
  /** Asked for a name when the server has none and the address would give "localhost"; `suggested` is that address-derived name. */
  askName?(suggested: string): Promise<string>;
  deps: InstallationsDeps;
}

export interface SetupResult {
  installation: Installation;
  /** False when the address was already set up: only the token changed. */
  created: boolean;
  mcp: McpStatus;
  /** The installed build speaks a host protocol older than the command accepts (or none). */
  tooOld: boolean;
  /** Agents restarted after a token replacement. */
  restarted: string[];
}

const versionParts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);

export function isOlder(version: string, than: string): boolean {
  const [a, b] = [versionParts(version), versionParts(than)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0);
  }
  return false;
}

async function chooseName(options: SetupOptions, info: InstanceInfo, url: string): Promise<{ name: string; chosen: boolean }> {
  if (options.name?.trim()) return { name: options.name.trim(), chosen: true };
  const received = info.redlineInstanceName && receivedInstanceName(info.redlineInstanceName);
  if (received) return { name: received, chosen: false };
  const suggested = redlineInstanceFallbackName(url);
  if (suggested !== "localhost" && suggested !== "") return { name: suggested, chosen: false };
  if (!options.askName) throw new SetupRefusal("The server has no instance name (REDLINE_INSTANCE_NAME).\n  Name this installation: redline setup " + url + " --name <name>");
  const asked = (await options.askName(suggested)).trim();
  if (!asked) throw new SetupRefusal("A name is required.");
  return { name: asked, chosen: true };
}

/**
 * Creates the installation of a Redline instance, or, for an address already set up, replaces its token (name and build kept).
 * Nothing is saved unless the token is accepted and the build installed. Claude Code missing does not undo the installation.
 */
export async function setupInstallation(options: SetupOptions): Promise<SetupResult> {
  const { configDir, deps } = options;
  const url = checkedAddress(options.serverUrl);
  const token = options.token.trim();
  if (!token) throw new SetupRefusal("A token is required.");
  if (hasLegacyLayout(configDir)) {
    throw new SetupRefusal("This computer still has the old Redline installation (one login for every server).\n  Run redline migrate first: it moves each server to its own installation.");
  }
  let info: InstanceInfo;
  try {
    info = await deps.fetchInstance(url, token);
  } catch (error) {
    throw new SetupRefusal(`Cannot use ${url} with this token: ${(error as Error).message}`);
  }

  const existing = listInstallations(configDir).find((installation) => installation.serverUrl === url);
  if (existing) {
    const installation = { ...existing, token };
    writeLogin(existing.dir, { serverUrl: url, token, name: existing.name, nameChosen: existing.nameChosen });
    const restarted = await deps.restartStoppedAgents(url);
    const mcp = await deps.registerMcp();
    return { installation, created: false, mcp, tooOld: isTooOld(existing, deps), restarted };
  }

  const { name, chosen } = await chooseName(options, info, url);
  const id = redlineInstanceHandle(name);
  if (!id) throw new SetupRefusal(`"${name}" cannot make a folder name. Pick another one: redline setup ${url} --name <name>`);
  const clash = listInstallations(configDir).find((installation) => installation.id === id || redlineInstanceHandle(installation.name) === id);
  if (clash) {
    throw new SetupRefusal(`The name "${name}" (${id}) is already used by ${clash.serverUrl}.\n  Pick another one: redline setup ${url} --name <name>`);
  }

  try {
    await createInstallation({ configDir, id, serverUrl: url, token, name, nameChosen: chosen, deps });
  } catch (error) {
    throw new SetupRefusal(`Could not install ${name}'s build: ${(error as Error).message.replace(/\.$/, "")}.\n  Nothing was saved. Check that the server is up, then run the command again.`);
  }
  const installation = readInstallation(configDir, id)!;
  const withInfo = { ...installation, version: installation.version ?? info.version, buildHash: installation.buildHash ?? info.buildHash };
  const mcp = await deps.registerMcp();
  return { installation: withInfo, created: true, mcp, tooOld: isTooOld(withInfo, deps), restarted: [] };
}

const isTooOld = (installation: Installation, deps: InstallationsDeps) => !acceptsProtocol(hostProtocol(deps.commandVersion, deps.hostProtocol), installation.hostProtocol);
