import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Login {
  serverUrl: string;
  token: string;
}

export function defaultConfigDir(): string {
  return process.env.REDLINE_CONFIG_DIR ?? join(homedir(), ".config", "redline");
}

/** Stores the server URL and token for every agent on this machine. */
export function login({ configDir, serverUrl, token }: Login & { configDir: string }): void {
  mkdirSync(configDir, { recursive: true });
  const stored: Login = { serverUrl: serverUrl.replace(/\/+$/, ""), token: token.trim() };
  const file = join(configDir, "login.json");
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created: tighten one that already existed.
  chmodSync(file, 0o600);
}

export function readLogin(configDir: string): Login {
  try {
    return JSON.parse(readFileSync(join(configDir, "login.json"), "utf8")) as Login;
  } catch {
    throw new Error("Not logged in. Run `redline login <server-url>` first.");
  }
}
