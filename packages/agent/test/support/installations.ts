import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstallation, installationId, installedPackageDir, type InstallationsDeps, type InstanceInfo, type McpStatus } from "../../src/installations.js";

export const tempDir = (prefix = "redline-inst-") => mkdtempSync(join(tmpdir(), prefix));

/** A fake `claude` that remembers its user-scope MCP entry in a file and logs every call. */
export function fakeClaude() {
  const dir = tempDir("redline-claude-");
  const state = join(dir, "entry");
  const log = join(dir, "calls");
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "mcp get")
    [ -f "${state}" ] || exit 1
    printf 'redline:\\n  Scope: User config (available in all your projects)\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n' "$(sed -n 1p "${state}")" "$(sed -n 2p "${state}")" ;;
  "mcp add") shift 6; printf '%s\\n%s\\n' "$1" "$2" > "${state}" ;;
  "mcp remove") rm -f "${state}" ;;
esac
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { env: { PATH: `${dir}:/usr/bin:/bin` }, state, calls };
}

/** What a build installed from a server leaves under an npm prefix. */
export function writeInstalledBuild(prefix: string, { version, buildHash }: { version: string; buildHash?: string }): void {
  const dir = installedPackageDir(prefix);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "redline-cli", version }));
  writeFileSync(join(dir, "dist", "cli.js"), "");
  if (buildHash) writeFileSync(join(dir, "build-hash.txt"), buildHash);
}

export interface FakeWorld {
  deps: InstallationsDeps;
  installs: { serverUrl: string; prefix: string }[];
  /** Instance info each server answers; a server missing here refuses the token. */
  servers: Map<string, InstanceInfo>;
  mcp: { status: McpStatus; registrations: number };
  /** Agent names the fake host restarts, per call. */
  restarted: string[];
  failInstall?: string;
}

/** Fake npm, Claude Code, servers and host for the installations module; `world.failInstall` makes the next install fail. */
export function fakeWorld(overrides: Partial<InstallationsDeps> = {}): FakeWorld {
  const world: FakeWorld = { installs: [], servers: new Map(), mcp: { status: "registered", registrations: 0 }, restarted: [], deps: undefined as never };
  world.deps = {
    commandVersion: "0.3.0",
    oldestAccepted: "0.2.0",
    async fetchInstance(serverUrl) {
      const info = world.servers.get(serverUrl);
      if (!info) throw new Error("the token was refused");
      return info;
    },
    async install(serverUrl, prefix) {
      world.installs.push({ serverUrl, prefix });
      if (world.failInstall) throw new Error(world.failInstall);
      writeInstalledBuild(prefix, { version: world.servers.get(serverUrl)?.version ?? "0.2.0", buildHash: world.servers.get(serverUrl)?.buildHash });
    },
    async registerMcp() {
      const status = world.mcp.registrations === 0 ? world.mcp.status : "already";
      if (status === "registered") world.mcp.registrations += 1;
      return status;
    },
    async restartStoppedAgents() {
      return world.restarted;
    },
    ...overrides,
  };
  return world;
}

export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** An installation on disk, as setup leaves it (its build included unless `version` is left out). */
export function addInstallation(configDir: string, { name, serverUrl, token = "abt_t", version = "0.2.0", nameChosen = false }: { name: string; serverUrl: string; token?: string; version?: string | null; nameChosen?: boolean }) {
  const id = installationId(name);
  const dir = join(configDir, "instances", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "login.json"), JSON.stringify({ serverUrl, token, name, nameChosen }));
  if (version) writeInstalledBuild(join(dir, "npm"), { version, buildHash: `h-${id}` });
  return findInstallation(configDir, id)!;
}

/** A folder, with `.redline/project.json` holding `link` when given. */
export function folderWithLink(link?: object, parent = tempDir("redline-folder-")): string {
  if (link) {
    mkdirSync(join(parent, ".redline"), { recursive: true });
    writeFileSync(join(parent, ".redline", "project.json"), JSON.stringify(link));
  }
  return parent;
}
