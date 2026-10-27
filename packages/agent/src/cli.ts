#!/usr/bin/env node
import { EFFORTS, modelLabel, type Effort, type ModelChoice, type Project } from "@redline/shared";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { buildHash } from "./build-hash.js";
import { checkClaude } from "./claude.js";
import { claudeCodeEngine } from "./claude-code-engine.js";
import { chooseModelEffort } from "./launch-choice.js";
import { linkFolder, serverForFolder, type LinkChoice } from "./link.js";
import { defaultConfigDir, pickServer, requireLogins, saveLogin, validateServerUrl, type Login } from "./login.js";
import { askSecret } from "./secret-prompt.js";
import { ServerApi } from "./server-api.js";
import { serveAgent } from "./serve-agent.js";
import { setupServer } from "./setup.js";
import { serveTerminalMcp } from "./terminal-mcp.js";

async function runSetup(args: string[]): Promise<void> {
  const serverUrl = args[0]?.startsWith("--") ? undefined : args[0];
  if (!serverUrl) throw new Error("Usage: redline setup <server-url> --token <token>");
  const token = flagValue(args, "--token") ?? (await askSecret("Agents' token (shown on the Agents screen): "));
  await setupServer({ configDir: defaultConfigDir(), serverUrl, token });
  console.log("Server saved and Redline registered in Claude Code. Run `redline agent` in a project folder to connect.");
}

/** Interactive alias of `redline setup`: asks for the token and only stores the server. */
async function runLogin(serverUrl: string | undefined): Promise<void> {
  if (!serverUrl) throw new Error("Usage: redline login <server-url>");
  const url = validateServerUrl(serverUrl);
  const token = (await askSecret("Agents' token (shown on the Agents screen): ")).trim();
  if (!token) throw new Error("A token is required.");
  saveLogin({ configDir: defaultConfigDir(), serverUrl: url, token });
  console.log("Saved. Run `redline agent` in a project folder to connect.");
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

async function askLinkChoice(projects: Project[]): Promise<LinkChoice> {
  console.log("This folder is not linked to a project yet.");
  projects.forEach((project, index) => console.log(`  ${index + 1}. ${project.title}`));
  console.log("  n. Create a new project");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("Pick a project: ")).trim().toLowerCase();
      const picked = projects[Number(answer) - 1];
      if (picked) return { existing: picked.id };
      if (answer === "n" || (answer === "" && projects.length === 0)) {
        const title = (await rl.question("New project title: ")).trim();
        if (title) return { create: title };
      }
    }
  } finally {
    rl.close();
  }
}

async function runInit(): Promise<void> {
  const servers = requireLogins(defaultConfigDir());
  await linkFolder({ folder: process.cwd(), servers, chooseServer: askServer, choose: askLinkChoice });
  console.log("Folder linked. Run `redline agent` to start serving it.");
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

/** Asks the model and effort in a terminal; outside one, the folder's last choice is used as is. */
async function askModelEffort(folder: string, flags: ModelChoice) {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    const claudeSettingsFile = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
    return await chooseModelEffort({ folder, configDir: defaultConfigDir(), claudeSettingsFile, flags, ask: rl && ((question) => rl.question(question)), warn: console.error });
  } finally {
    rl?.close();
  }
}

async function runAgent(args: string[]): Promise<void> {
  const flags = { model: flagValue(args, "--model"), effort: parseEffort(flagValue(args, "--effort")) };
  await checkClaude();
  const servers = requireLogins(defaultConfigDir());
  const kind = args.includes("--global") ? "global" : "project";
  const folder = process.cwd();
  let server: Login;
  let projectId: string | undefined;
  if (kind === "global") server = pickServer(servers, flagValue(args, "--server"));
  else {
      ({ projectId, server } = await linkFolder({ folder, servers, chooseServer: askServer, choose: askLinkChoice }));
  }
  const { serverUrl, token } = server;
  const { model, effort } = await askModelEffort(folder, flags);
  console.log(`Runs use ${modelLabel(model)} · ${effort ?? "Claude's default effort"}.`);
  const identity = { serverUrl, token, machine: hostname(), folder, kind, projectId } as const;

  const service = serveAgent({ ...identity, engine: claudeCodeEngine(), model, effort, log: console.log });
  process.on("SIGINT", () => {
    console.log("\nAgent stopped.");
    service.stop();
  });
  await service.done;
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
  else if (command === "init") await runInit();
  else if (command === "agent") await runAgent(args);
  else if (command === "mcp") await runMcp();
  else if (command === "build-hash") console.log(buildHash());
  else throw new Error("Usage: redline setup <server-url> --token <token> | redline login <server-url> | redline init | redline mcp | redline agent [--global [--server <url>]] [--model <model>] [--effort <low|medium|high|xhigh|max>]");
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
