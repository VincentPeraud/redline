#!/usr/bin/env node
import { EFFORTS, modelLabel, type AgentKind, type Effort, type ModelChoice, type Project } from "@redline/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { HostAlreadyRunningError, startAgentHost } from "./agent-host.js";
import { runAgentsScreen, type InstancesPort } from "./agents-screen.js";
import { closeSummary } from "./agents-view.js";
import { runAgentWorker } from "./agent-worker.js";
import { buildHash } from "./build-hash.js";
import { checkClaude, claudeConfigDirOf, claudeSettingsFileOf } from "./claude.js";
import { claudeCodeEngine } from "./claude-code-engine.js";
import { ensureHost, type HostClient } from "./host-client.js";
import { chooseModelEffort } from "./launch-choice.js";
import { linkFolder, linkFolderToServer, linkedServer, listProjects, type LinkChoice, type MoreChoice } from "./link.js";
import { SetupRefusal, type Installation, addressOf, checkedAddress, currentInstallation, findInstallation, hasLegacyLayout, installationLogins, listInstallations, pickInstallation, resolveFolder, setupInstallation } from "./installations.js";
import { removeInstallation, removeReport, updateInstallation, updateReport } from "./installation-update.js";
import { askInstallation, confirm, orphanLines, runLink } from "./link-command.js";
import { ensureGlobalCommand, launchedThroughNpx, systemGlobalCommand } from "./global-command.js";
import { importAndServe, launchMcp } from "./mcp-launcher.js";
import { connectMigrateHost, legacyRefusal, migrateLegacy } from "./migrate.js";
import { cliVersion } from "./build-hash.js";
import { fileURLToPath } from "node:url";
import { defaultConfigDir, type Login } from "./login.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { servingAgent } from "./serving-agent.js";
import { askSecret } from "./secret-prompt.js";
import { serveAgent } from "./serve-agent.js";
import { doctorReport, gatherDoctor } from "./doctor.js";
import { inspectInstallation } from "./instance-details.js";
import { setupReport, systemDeps, systemDoctorDeps } from "./setup.js";
import { createNewAgentFlow } from "./new-agent.js";
import { helpLines } from "./commands-help.js";
import { folderLineOf, instanceEntries } from "./instance-list.js";
import { openWithSystem } from "./open-url.js";
import { openTerminal } from "./terminal-driver.js";
import { RELAUNCHED_ENV, UPDATE_EXIT_CODE, WORKER_ENV, superviseAgent } from "./supervisor.js";

/** `redline setup <address> [--name <name>] [--token <token>]`; `redline login` is the same, asking for the address when it is not given. */
async function runSetup(args: string[], { askAddress }: { askAddress: boolean }): Promise<void> {
  const positional = args[0]?.startsWith("--") ? undefined : args[0];
  const serverUrl = positional ?? (askAddress ? await ask("Server URL: ") : undefined);
  if (!serverUrl) throw new Error("Usage: redline setup <address> [--name <name>] [--token <token>]");
  const configDir = defaultConfigDir();
  const deps = systemDeps(configDir);
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  try {
    checkedAddress(serverUrl);
    const token = flagValue(args, "--token") ?? (await askSecret("Agents' token (shown on the Agents screen): "));
    if (launchedThroughNpx(process.env, fileURLToPath(new URL("..", import.meta.url)))) await prepareFromNpx(checkedAddress(serverUrl), color);
    const result = await setupInstallation({
      configDir,
      serverUrl,
      token,
      name: flagValue(args, "--name"),
      askName: () => ask("The server has no instance name (REDLINE_INSTANCE_NAME). Name for this installation: "),
      deps,
    });
    for (const line of setupReport(result, { deps, color })) console.log(line);
    if (result.mcp === "claude-missing") process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof SetupRefusal)) throw error;
    console.error(`${color ? "\u001b[38;2;217;45;32m✗ " : "✗ "}${(error as Error).message}${color ? "\u001b[0m" : ""}`);
    process.exitCode = 1;
  }
}

/** Run by the panel's npx command: the global `redline` command is installed when missing or older, and an old computer migrates first. */
async function prepareFromNpx(serverUrl: string, color: boolean): Promise<void> {
  try {
    const done = await ensureGlobalCommand(serverUrl, cliVersion(), systemGlobalCommand);
    if (done !== "current") console.log(`✓ redline command ${done} (v${cliVersion()}).`);
  } catch (error) {
    throw new SetupRefusal(`Could not install the redline command: ${(error as Error).message}\n  Nothing else was changed. Run npm i -g ${serverUrl}/cli/redline-cli.tgz yourself, then run the command again.`);
  }
  if (hasLegacyLayout(defaultConfigDir())) {
    console.log("This computer has the old Redline installation: migrating it first.");
    await runMigrate([], color);
  }
}

/** `redline migrate [--now] [--name <address>=<name>]`. */
async function runMigrate(args: string[], color: boolean): Promise<void> {
  const configDir = defaultConfigDir();
  const names: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== "--name") return;
    const [address, ...name] = (args[index + 1] ?? "").split("=");
    if (!address || name.join("=").trim() === "") throw new Error("--name needs <address>=<name>.");
    names[address] = name.join("=").trim();
  });
  const { left } = await migrateLegacy({ configDir, deps: systemDeps(configDir), host: await connectMigrateHost(configDir), now: args.includes("--now"), names, out: console.log, color });
  if (left > 0) process.exitCode = 1;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askServer(servers: Login[]): Promise<Login> {
  const known = listInstallations(defaultConfigDir()).filter((installation) => servers.some((server) => server.serverUrl === installation.serverUrl));
  console.log("Several Redline instances are set up on this computer.");
  const { serverUrl, token } = await askInstallation(known, { ask, out: console.log });
  return { serverUrl, token };
}

const titles = (projects: Project[]) => projects.map((project) => sanitizeForTerminal(project.title)).join(", ");

async function pickProject(rl: Interface, projects: Project[]): Promise<LinkChoice> {
  projects.forEach((project, index) => console.log(`  ${index + 1}. ${sanitizeForTerminal(project.title)}`));
  console.log("  n. Create a new project");
  for (;;) {
    const answer = (await rl.question("Pick a project: ")).trim().toLowerCase();
    const picked = projects[Number(answer) - 1];
    if (picked) return { existing: picked.id };
    if (answer === "n" || (answer === "" && projects.length === 0)) {
      const title = (await rl.question("New project title: ")).trim();
      if (title) return { create: title };
    }
  }
}

async function askLinkChoice(projects: Project[]): Promise<LinkChoice> {
  console.log("This folder is not linked to a project yet.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await pickProject(rl, projects);
  } finally {
    rl.close();
  }
}

/** A linked folder can serve one more project, or one less (never none); Enter starts the agent as is. */
async function askMoreProjects(where: string, linked: Project[], others: Project[]): Promise<MoreChoice | undefined> {
  console.log(`This folder serves ${titles(linked)}${where}.`);
  const canRemove = linked.length > 1;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`Press Enter to start, a to add a project${canRemove ? ", r to remove one" : ""}: `)).trim().toLowerCase();
      if (answer === "") return undefined;
      if (answer === "a") return await pickProject(rl, others);
      if (answer === "r" && canRemove) {
        linked.forEach((project, index) => console.log(`  ${index + 1}. ${sanitizeForTerminal(project.title)}`));
        for (;;) {
          const picked = linked[Number((await rl.question("Stop serving: ")).trim()) - 1];
          if (picked) return { remove: picked.id };
        }
      }
    }
  } finally {
    rl.close();
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}

function parseEffort(value: string | undefined): Effort | undefined {
  if (value === undefined) return undefined;
  if (!(EFFORTS as readonly string[]).includes(value)) throw new Error(`--effort must be one of: ${EFFORTS.join(", ")}.`);
  return value as Effort;
}

/** Asks the model and effort in a terminal; outside one, or after an update relaunch, the folder's last choice is used as is. */
/** Questions are asked in a terminal, but not when the supervisor relaunches the agent after an update. */
const canPrompt = () => process.stdin.isTTY && !process.env[RELAUNCHED_ENV];

async function askModelEffort(folder: string, flags: ModelChoice) {
  const rl = canPrompt() ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    return await chooseModelEffort({ folder, configDir: defaultConfigDir(), claudeSettingsFile: claudeSettingsFileOf(), flags, ask: rl && ((question) => rl.question(question)), warn: console.error });
  } finally {
    rl?.close();
  }
}

async function runAgent(args: string[]): Promise<void> {
  const flags = { model: flagValue(args, "--model"), effort: parseEffort(flagValue(args, "--effort")) };
  const account = await checkClaude();
  const kind = args.includes("--global") ? "global" : "project";
  const folder = process.cwd();
  if (kind === "project" && !(await resolveOrphanedLink(folder))) return;
  const servers = installationLogins(defaultConfigDir());
  if (servers.length === 0) throw new Error("No server set up. Run `redline setup <address> --token <token>` first.");
  const host = runsInBackground() ? await connectHost() : undefined;
  try {
    // Attached from now on: the host would exit, with no agent yet, while the questions are being answered.
    await host?.subscribe(() => undefined);
    await startOrOpenAgent({ args, flags, account, servers, kind, folder, host });
  } finally {
    host?.close();
  }
}

/** A folder linked to an address with no installation here: says so, and re-links it only when the user agrees. False: stop. */
async function resolveOrphanedLink(folder: string): Promise<boolean> {
  const configDir = defaultConfigDir();
  const resolved = resolveFolder(configDir, folder);
  if (resolved.kind !== "orphan") return true;
  const [problem, remedy] = orphanLines(resolved.serverUrl);
  console.error(`✗ ${problem}`);
  console.error(remedy);
  const installations = listInstallations(configDir);
  if (installations.length === 0 || !(await confirm(ask, "Link this folder to another instance instead? (y/N): "))) {
    console.log("Nothing changed.");
    process.exitCode = 1;
    return false;
  }
  const target = await askInstallation(installations, { ask, out: console.log });
  linkFolderToServer(folder, target.serverUrl);
  return true;
}

interface AgentRequest {
  args: string[];
  flags: ModelChoice;
  account: string | undefined;
  servers: Login[];
  kind: AgentKind;
  folder: string;
  /** The agent host, in a terminal; absent when the agent runs in this process. */
  host: HostClient | undefined;
}

async function startOrOpenAgent({ args, flags, account, servers, kind, folder, host }: AgentRequest): Promise<void> {
  // Before any question: an agent that already serves this folder is opened as it is, and its choices stay untouched.
  const wanted = flagValue(args, "--instance") ?? flagValue(args, "--server");
  const known = host && (kind === "global" ? pickInstallation(defaultConfigDir(), wanted) : linkedServer(folder, servers));
  const serving = host && known && (await servingAgent({ host, folder, serverUrl: known.serverUrl }));
  if (host && serving) {
    console.log(`An agent already serves this folder (${serving.name}): opening it.`);
    await showAgentsScreen(host, serving.id);
    return;
  }
  let server: Login;
  let projectIds: string[] | undefined;
  let projectNames: string[] | undefined;
  if (kind === "global") server = pickInstallation(defaultConfigDir(), wanted);
  else {
    let projects: Project[];
    const configDir = defaultConfigDir();
    const here = resolveFolder(configDir, folder);
    const label = async (installation: Installation) => {
      const current = await currentInstallation(configDir, installation, systemDeps(configDir).fetchInstance);
      return { name: current.name, address: `${addressOf(current.serverUrl)}${current.version ? ` · v${current.version}` : ""}` };
    };
    const linkedLabel = here.kind === "linked" && "root" in here ? await label(here.installation) : undefined;
    const chooseMore = canPrompt() ? (linked: Project[], others: Project[]) => askMoreProjects(linkedLabel ? ` on ${linkedLabel.name} (${linkedLabel.address})` : "", linked, others) : undefined;
    ({ projectIds, projects, server } = await linkFolder({ folder, servers, chooseServer: askServer, choose: askLinkChoice, chooseMore }));
    projectNames = projects.map((project) => project.title);
    const used = listInstallations(configDir).find((installation) => installation.serverUrl === server.serverUrl);
    console.log(`Serving ${titles(projects)}${used ? ` on ${(await label(used)).name}` : ""}.`);
  }
  const { serverUrl, token } = server;
  const { model, effort } = await askModelEffort(folder, flags);
  if (host) {
    const { agent, started } = await host.launch({ folder, kind, serverUrl, projectIds, projectNames, model, effort, claudeConfigDir: claudeConfigDirOf(), account });
    console.log(started ? "(the agents screen opens on this agent — q closes it)" : `An agent already serves this folder (${agent.name}): opening it.`);
    await showAgentsScreen(host, agent.id);
    return;
  }
  console.log(`Runs use ${modelLabel(model)} · ${effort ?? "Claude's default effort"}${account ? `, account ${account}` : ""}.`);
  const identity = { serverUrl, token, machine: hostname(), folder, kind, projectIds } as const;

  const service = serveAgent({ ...identity, engine: claudeCodeEngine(), model, effort, log: console.log });
  process.on("SIGINT", () => service.stop());
  const { updated } = await service.done;
  if (updated) process.exit(UPDATE_EXIT_CODE);
}

const connectHost = () => ensureHost({ configDir: defaultConfigDir(), hostCommand: { command: process.execPath, args: [process.argv[1], "host"] } });

/** Opens the agents screen, then prints, in the shell, the agents that keep running. */
async function showAgentsScreen(host: HostClient, selectedId?: string): Promise<void> {
  const folder = process.cwd();
  const configDir = defaultConfigDir();
  const newAgent = createNewAgentFlow({ folder, configDir, claudeSettingsFile: claudeSettingsFileOf(), host, checkClaude });
  const installations = await Promise.all(listInstallations(configDir).map((installation) => currentInstallation(configDir, installation, systemDeps(configDir).fetchInstance)));
  const resolution = resolveFolder(configDir, folder);
  const titles = resolution.kind === "linked" && resolution.projectIds.length > 0 ? await projectTitles(resolution.installation, resolution.projectIds) : undefined;
  const closed = await runAgentsScreen({
    host,
    terminal: openTerminal(),
    selectedId,
    home: homedir(),
    folder,
    instances: instanceEntries(installations),
    folderLine: folderLineOf(resolution, titles),
    linkFolder: async (serverUrl) => {
      linkFolderToServer(folder, serverUrl);
      return folderLineOf(resolveFolder(configDir, folder));
    },
    newAgent,
    instancesPort: instancesPort(configDir),
    openUrl: openWithSystem,
  });
  for (const line of closeSummary(closed)) console.log(line);
  // `s` on the Instances tab: the screen is closed, so that the setup can ask for the address and the token.
  if (closed.instancesTab.setupAfter) await runSetup([], { askAddress: true });
}

/** The Instances tab's diagnoses and actions: doctor's diagnosis, `redline update` and `redline remove` for one installation. */
function instancesPort(configDir: string): InstancesPort {
  const deps = systemDeps(configDir);
  const installationOf = (id: string): Installation => {
    const installation = findInstallation(configDir, id);
    if (!installation) throw new SetupRefusal(`${id} is not installed on this computer.`);
    return installation;
  };
  return {
    inspect: (id) => inspectInstallation(installationOf(id), { ...deps, timeoutMs: 5000 }),
    async update(id) {
      const result = await updateInstallation({ configDir, wanted: id, deps });
      return { lines: updateReport(result), version: result.to };
    },
    async remove(id) {
      return removeReport(await removeInstallation({ configDir, wanted: id, deps, home: homedir() }), { home: homedir() });
    },
  };
}

/** What the folder's link serves, by title, for the screen's folder line; nothing when the server does not answer in time. */
async function projectTitles(installation: Installation, projectIds: string[]): Promise<string | undefined> {
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3000).unref());
  const projects = await Promise.race([listProjects(installation, true).catch(() => undefined), timeout]);
  const served = projects?.filter((project) => projectIds.includes(project.id)).map((project) => sanitizeForTerminal(project.title));
  return served && served.length > 0 ? served.join(", ") : undefined;
}

/** `redline agents`, and bare `redline` in a terminal: the agents screen on the first agent, launching nothing. */
async function runAgents(): Promise<void> {
  if (!runsInBackground()) throw new Error("`redline agents` needs a terminal (not available on Windows yet).");
  const host = await connectHost();
  try {
    await showAgentsScreen(host);
  } finally {
    host.close();
  }
}

/** In a terminal (not on Windows, which has no host yet) the agent runs in the agent host, which outlives the terminal. */
const runsInBackground = () => Boolean(process.stdin.isTTY) && process.platform !== "win32" && !process.env[WORKER_ENV];

/** Without a terminal, `redline agent` supervises a worker process running the agent, so that an update from the browser can restart it. */
async function superviseOrRunAgent(args: string[]): Promise<void> {
  if (process.env[WORKER_ENV] || runsInBackground()) return runAgent(args);
  process.exitCode = await superviseAgent({ command: process.execPath, args: [process.argv[1], "agent", ...args], log: console.log });
}

/** The agent host, started detached by `redline agent`: it runs until no agent runs and no screen is attached. */
async function runHost(): Promise<void> {
  // Everything the host creates is private to the user, whatever the shell's umask.
  process.umask(0o077);
  // Each worker runs its installation's own code; the replacement host, started when the global command changes, is this command's.
  const host = await startAgentHost({
    configDir: defaultConfigDir(),
    worker: (installation) => ({ command: process.execPath, args: [installation.entry, "worker"] }),
    respawn: { command: process.execPath, args: [process.argv[1], "host"] },
  }).catch((error) => {
    if (error instanceof HostAlreadyRunningError) return undefined;
    throw error;
  });
  await host?.closed;
}

/** Terminal mode: an MCP server on stdio for the user's own Claude Code (registered by `redline setup`). */
async function runMcp(): Promise<void> {
  const configDir = defaultConfigDir();
  const fallback = await launchMcp({ configDir, folder: process.cwd(), home: homedir(), fetchInstance: systemDeps(configDir).fetchInstance, handOver: importAndServe });
  if (!fallback) return;
  await fallback.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.on("end", resolve));
}

/** `redline update <instance|address>`. */
async function runUpdate(args: string[]): Promise<void> {
  const [wanted] = args;
  if (!wanted) throw new Error("Usage: redline update <instance|address>");
  const configDir = defaultConfigDir();
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  await reportRefusal(color, async () => {
    for (const line of updateReport(await updateInstallation({ configDir, wanted, deps: systemDeps(configDir) }))) console.log(line);
  });
}

/** `redline remove <instance>`. */
async function runRemove(args: string[]): Promise<void> {
  const [wanted] = args;
  if (!wanted) throw new Error("Usage: redline remove <instance>");
  const configDir = defaultConfigDir();
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  await reportRefusal(color, async () => {
    for (const line of removeReport(await removeInstallation({ configDir, wanted, deps: systemDeps(configDir), home: homedir() }), { home: homedir() })) console.log(line);
  });
}

/** A refusal is printed after a red "✗ " and sets the exit code; any other error is a bug and goes on. */
async function reportRefusal(color: boolean, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof SetupRefusal)) throw error;
    console.error(`${color ? "\u001b[38;2;217;45;32m✗ " : "✗ "}${error.message}${color ? "\u001b[0m" : ""}`);
    process.exitCode = 1;
  }
}

/** `redline doctor`: works before the migration too; exits 1 when something is wrong. */
async function runDoctor(): Promise<void> {
  const configDir = defaultConfigDir();
  const state = await gatherDoctor({ configDir, folder: process.cwd(), deps: systemDoctorDeps(configDir) });
  const { lines, problems } = doctorReport(state, { color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, home: homedir() });
  for (const line of lines) console.log(line);
  if (problems > 0) process.exitCode = 1;
}

/** `redline link [<instance>]`. */
async function runLinkCommand(args: string[]): Promise<void> {
  const configDir = defaultConfigDir();
  await runLink({
    configDir,
    folder: process.cwd(),
    wanted: args[0],
    home: homedir(),
    fetchInstance: systemDeps(configDir).fetchInstance,
    projectNames: async ({ serverUrl, token }, ids) => (await listProjects({ serverUrl, token }, true)).filter((project) => ids.includes(project.id)).map((project) => sanitizeForTerminal(project.title)),
    ask,
    out: console.log,
  });
}

const printHelp = () => helpLines().forEach((line) => console.log(line));

const [command, ...args] = process.argv.slice(2);
/** What still works while the old single installation remains: migrate, doctor, help, and the processes the commands start. */
const WORKS_BEFORE_MIGRATE = ["migrate", "doctor", "help", "mcp", "host", "worker", "build-hash"];
try {
  if (hasLegacyLayout(defaultConfigDir()) && !WORKS_BEFORE_MIGRATE.includes(command ?? "")) {
    console.error(`✗ ${legacyRefusal(command === undefined)}`);
    process.exit(1);
  }
  if (command === "setup") await runSetup(args, { askAddress: false });
  else if (command === "login") await runSetup(args, { askAddress: true });
  else if (command === "migrate") await runMigrate(args, Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  else if (command === "link") await runLinkCommand(args);
  else if (command === "update") await runUpdate(args);
  else if (command === "remove") await runRemove(args);
  else if (command === "doctor") await runDoctor();
  else if (command === "agent") await superviseOrRunAgent(args);
  else if (command === "agents") await runAgents();
  else if (command === undefined) await (runsInBackground() && process.stdout.isTTY ? runAgents() : printHelp());
  else if (command === "help") printHelp();
  else if (command === "mcp") await runMcp();
  else if (command === "host") await runHost();
  else if (command === "worker") runAgentWorker({ engine: claudeCodeEngine() });
  else if (command === "build-hash") console.log(buildHash());
  else throw new Error(`Unknown command: ${command}. \`redline help\` lists the commands.`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
