#!/usr/bin/env node
import { EFFORTS, modelLabel, type Effort, type ModelChoice, type Project } from "@redline/shared";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { HostAlreadyRunningError, startAgentHost } from "./agent-host.js";
import { runAgentsScreen } from "./agents-screen.js";
import { closeSummary } from "./agents-view.js";
import { runAgentWorker } from "./agent-worker.js";
import { buildHash } from "./build-hash.js";
import { checkClaude, claudeConfigDirOf, claudeSettingsFileOf } from "./claude.js";
import { claudeCodeEngine } from "./claude-code-engine.js";
import { ensureHost, type HostClient } from "./host-client.js";
import { chooseModelEffort } from "./launch-choice.js";
import { linkFolder, serverForFolder, type LinkChoice, type MoreChoice } from "./link.js";
import { defaultConfigDir, pickServer, requireLogins, type Login } from "./login.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { askSecret } from "./secret-prompt.js";
import { ServerApi } from "./server-api.js";
import { serveAgent } from "./serve-agent.js";
import { setupServer } from "./setup.js";
import { createNewAgentFlow } from "./new-agent.js";
import { openWithSystem } from "./open-url.js";
import { openTerminal } from "./terminal-driver.js";
import { RELAUNCHED_ENV, UPDATE_EXIT_CODE, WORKER_ENV, superviseAgent } from "./supervisor.js";
import { serveTerminalMcp } from "./terminal-mcp.js";

async function runSetup(args: string[]): Promise<void> {
  const serverUrl = args[0]?.startsWith("--") ? undefined : args[0];
  if (!serverUrl) throw new Error("Usage: redline setup <server-url> --token <token>");
  const token = flagValue(args, "--token") ?? (await askSecret("Agents' token (shown on the Agents screen): "));
  await setupServer({ configDir: defaultConfigDir(), serverUrl, token });
  console.log("Server saved and Redline registered in Claude Code. Run `redline agent` in a project folder to connect.");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Interactive alias of `redline setup`: asks for the URL (unless given) and the token, then does the same. */
async function runLogin(serverUrl: string | undefined): Promise<void> {
  const url = serverUrl ?? (await ask("Server URL: "));
  if (!url) throw new Error("A server URL is required.");
  const token = await askSecret("Agents' token (shown on the Agents screen): ");
  await setupServer({ configDir: defaultConfigDir(), serverUrl: url, token });
  console.log("Server saved and Redline registered in Claude Code. Run `redline agent` in a project folder to connect.");
}

async function askServer(servers: Login[]): Promise<Login> {
  console.log("Several servers are set up.");
  servers.forEach((server, index) => console.log(`  ${index + 1}. ${server.serverUrl}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const picked = servers[Number((await rl.question("Pick a server: ")).trim()) - 1];
      if (picked) return picked;
    }
  } finally {
    rl.close();
  }
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
async function askMoreProjects(linked: Project[], others: Project[]): Promise<MoreChoice | undefined> {
  console.log(`This folder serves ${titles(linked)}.`);
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
  const servers = requireLogins(defaultConfigDir());
  const kind = args.includes("--global") ? "global" : "project";
  const folder = process.cwd();
  let server: Login;
  let projectIds: string[] | undefined;
  let projectNames: string[] | undefined;
  if (kind === "global") server = pickServer(servers, flagValue(args, "--server"));
  else {
    let projects: Project[];
    ({ projectIds, projects, server } = await linkFolder({ folder, servers, chooseServer: askServer, choose: askLinkChoice, chooseMore: canPrompt() ? askMoreProjects : undefined }));
    projectNames = projects.map((project) => project.title);
    console.log(`Serving ${titles(projects)}.`);
  }
  const { serverUrl, token } = server;
  const { model, effort } = await askModelEffort(folder, flags);
  if (runsInBackground()) {
    const host = await connectHost();
    try {
      const { agent, started } = await host.launch({ folder, kind, serverUrl, projectIds, projectNames, model, effort, claudeConfigDir: claudeConfigDirOf(), account });
      console.log(started ? "(the agents screen opens on this agent — q closes it)" : `An agent already serves this folder (${agent.name}): opening it.`);
      await showAgentsScreen(host, agent.id);
    } finally {
      host.close();
    }
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
  const newAgent = createNewAgentFlow({ folder, configDir: defaultConfigDir(), claudeSettingsFile: claudeSettingsFileOf(), host, checkClaude });
  const closed = await runAgentsScreen({ host, terminal: openTerminal(), selectedId, home: homedir(), folder, newAgent, openUrl: openWithSystem });
  for (const line of closeSummary(closed)) console.log(line);
}

/** `redline agents`: the agents screen on the first agent, launching nothing. */
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
  const host = await startAgentHost({ configDir: defaultConfigDir(), worker: { command: process.execPath, args: [process.argv[1], "worker"] } }).catch((error) => {
    if (error instanceof HostAlreadyRunningError) return undefined;
    throw error;
  });
  await host?.closed;
}

/** Terminal mode: an MCP server on stdio for the user's own Claude Code (registered by `redline setup`). */
async function runMcp(): Promise<void> {
  const { serverUrl, token } = serverForFolder(process.cwd(), requireLogins(defaultConfigDir()));
  await serveTerminalMcp({ api: new ServerApi(serverUrl, token), folder: process.cwd() });
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") await runSetup(args);
  else if (command === "login") await runLogin(args[0]);
  else if (command === "agent") await superviseOrRunAgent(args);
  else if (command === "agents") await runAgents();
  else if (command === "mcp") await runMcp();
  else if (command === "host") await runHost();
  else if (command === "worker") runAgentWorker({ engine: claudeCodeEngine() });
  else if (command === "build-hash") console.log(buildHash());
  else throw new Error("Usage: redline setup <server-url> --token <token> | redline login [<server-url>] | redline mcp | redline agents | redline agent [--global [--server <url>]] [--model <model>] [--effort <low|medium|high|xhigh|max>]");
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
