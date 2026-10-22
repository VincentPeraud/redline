#!/usr/bin/env node
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { checkClaude } from "./claude.js";
import { connectToServer } from "./connection.js";
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

async function runAgent(args: string[]): Promise<void> {
  await checkClaude();
  const { serverUrl, token } = readLogin(defaultConfigDir());
  const kind = args.includes("--global") ? "global" : "project";
  const identity = { serverUrl, token, machine: hostname(), folder: process.cwd(), kind } as const;

  process.on("SIGINT", () => {
    console.log("\nAgent stopped.");
    process.exit(0);
  });

  for (;;) {
    const connection = await connectToServer(identity);
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
  else if (command === "agent") await runAgent(args);
  else throw new Error("Usage: redline login <server-url> | redline agent [--global]");
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
