#!/usr/bin/env node
import { EFFORTS, type Effort, type Project } from "@redline/shared";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { checkClaude } from "./claude.js";
import { startAgent } from "./agent.js";
import { unavailableEngine } from "./engine.js";
import { linkFolder, type LinkChoice } from "./link.js";
import { defaultConfigDir, login, readLogin } from "./login.js";

const RECONNECT_DELAY_MS = 3000;

async function runLogin(serverUrl: string | undefined): Promise<void> {
  if (!serverUrl) throw new Error("Usage: redline login <server-url>");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = (await rl.question("Agents' token (shown on the Agents screen): ")).trim();
  rl.close();
  if (!token) throw new Error("A token is required.");
  login({ configDir: defaultConfigDir(), serverUrl, token });
  console.log("Saved. Run `redline agent` in a project folder to connect.");
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
  const { serverUrl } = readLogin(defaultConfigDir());
  await linkFolder({ folder: process.cwd(), serverUrl, choose: askLinkChoice });
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

async function runAgent(args: string[]): Promise<void> {
  const model = flagValue(args, "--model");
  const effort = parseEffort(flagValue(args, "--effort"));
  await checkClaude();
  const { serverUrl, token } = readLogin(defaultConfigDir());
  const kind = args.includes("--global") ? "global" : "project";
  const folder = process.cwd();
  const projectId = kind === "project" ? await linkFolder({ folder, serverUrl, choose: askLinkChoice }) : undefined;
  const identity = { serverUrl, token, machine: hostname(), folder, kind, projectId } as const;

  process.on("SIGINT", () => {
    console.log("\nAgent stopped.");
    process.exit(0);
  });

  for (;;) {
    const connection = await startAgent({ ...identity, engine: unavailableEngine, model, effort });
    console.log(`Connected to ${serverUrl} as ${kind} agent in ${identity.folder}. Ctrl-C to stop.`);
    const { reason } = await connection.closed;
    if (reason === "unauthorized") throw new Error("The token was regenerated. Run `redline login <server-url>` again.");
    console.log(`Connection lost, retrying in ${RECONNECT_DELAY_MS / 1000}s...`);
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "login") await runLogin(args[0]);
  else if (command === "init") await runInit();
  else if (command === "agent") await runAgent(args);
  else throw new Error("Usage: redline login <server-url> | redline init | redline agent [--global] [--model <model>] [--effort <low|medium|high|xhigh|max>]");
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
