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

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|.+\.localhost)$/;

const SAFE_HOST = /^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:]+\]$/i;
const SAFE_PATH = /^[A-Za-z0-9._~/-]*$/;

/**
 * The token travels in every call: only https, or a loopback host, may receive it. The URL also ends up in the
 * install command run on this machine, so it is reduced to origin + plain path: no credentials, query, fragment or
 * shell metacharacter.
 */
export function validateServerUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`"${url}" is not a valid server URL.`);
  }
  const secure = parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOST.test(parsed.hostname));
  if (!secure) {
    throw new Error("The server URL must start with https:// (http:// is only accepted for localhost, *.localhost and 127.0.0.1).");
  }
  const clean =
    !parsed.username && !parsed.password && !/[?#]/.test(normalized) && SAFE_HOST.test(parsed.hostname) && SAFE_PATH.test(parsed.pathname);
  if (!clean) {
    throw new Error(`"${url}" is not a plain server URL (no credentials, query, fragment or special characters).`);
  }
  return normalizeServerUrl(parsed.origin + parsed.pathname);
}

/** Every server set up on this machine. The old single-server file (one object) reads as a one-item list. */
export function readLogins(configDir: string): Login[] {
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(join(configDir, "login.json"), "utf8"));
  } catch {
    return [];
  }
  return (Array.isArray(stored) ? stored : [stored]).filter(
    (entry): entry is Login => typeof entry?.serverUrl === "string" && typeof entry?.token === "string",
  );
}

/** The login for a server URL (compared normalized), if the machine has one. */
export const loginFor = (configDir: string, serverUrl: string): Login | undefined => findLogin(readLogins(configDir), serverUrl);

/** The login for a server URL among `logins` (compared normalized). */
export function findLogin(logins: Login[], serverUrl: string): Login | undefined {
  const wanted = normalizeServerUrl(serverUrl);
  return logins.find((login) => normalizeServerUrl(login.serverUrl) === wanted);
}

export function requireLogins(configDir: string): Login[] {
  const servers = readLogins(configDir);
  if (servers.length === 0) throw new Error("No server set up. Run `redline setup <server-url> --token <token>` first.");
  return servers;
}

/** Adds the server, or updates its token if it is already there. The file is rewritten as a list. */
export function saveLogin({ configDir, serverUrl, token }: Login & { configDir: string }): void {
  mkdirSync(configDir, { recursive: true });
  const entry: Login = { serverUrl: normalizeServerUrl(serverUrl), token: token.trim() };
  const others = readLogins(configDir).filter((existing) => normalizeServerUrl(existing.serverUrl) !== entry.serverUrl);
  const file = join(configDir, "login.json");
  writeFileSync(file, JSON.stringify([...others, entry], null, 2), { mode: 0o600 });
  // `mode` only applies when the file is created: tighten one that already existed.
  chmodSync(file, 0o600);
}

/** The server to talk to: the wanted one, or the only one set up. */
export function pickServer(servers: Login[], wanted?: string): Login {
  if (wanted) {
    const url = normalizeServerUrl(wanted);
    const found = findLogin(servers, url);
    if (!found) throw new Error(`${url} is not set up. Run \`redline setup ${url} --token <token>\` first.`);
    return found;
  }
  if (servers.length > 1) {
    throw new Error(`Several servers are set up (${servers.map((s) => s.serverUrl).join(", ")}): pass --server <url>.`);
  }
  return servers[0];
}
