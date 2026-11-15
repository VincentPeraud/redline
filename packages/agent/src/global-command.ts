import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_TARBALL_PATH } from "@redline/shared";
import { isOlder } from "./installations.js";
import { npmInstall } from "./install-cli.js";

/**
 * Whether this process was started by `npx` (the web panel's `npx -y <server>/cli/redline-cli.tgz setup ...`) and not typed against
 * the global command: npm sets `npm_command=exec` for what `npx` runs, and the package then lives in npx's `_npx` cache.
 */
export const launchedThroughNpx = (env: NodeJS.ProcessEnv, packageDir: string): boolean => env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(packageDir);

/** The global command's package: its version, and its build hash when the package carries one. */
export interface GlobalCommandBuild {
  version: string;
  buildHash?: string;
}

export interface GlobalCommandDeps {
  /** The `redline-cli` package installed globally; undefined when there is none. */
  installed(): Promise<GlobalCommandBuild | undefined>;
  /** `npm i -g` of the tarball the server serves. */
  install(tarballUrl: string): Promise<void>;
}

/**
 * Installs the global `redline` command from this server when it is missing, older than the running build, or another build of the
 * same version; otherwise leaves it. A build run from the sources ("dev") never replaces one of the same version.
 */
export async function ensureGlobalCommand(serverUrl: string, own: { version: string; buildHash: string }, deps: GlobalCommandDeps): Promise<"installed" | "updated" | "current"> {
  const installed = await deps.installed();
  const otherBuild = installed !== undefined && installed.version === own.version && own.buildHash !== "dev" && installed.buildHash !== own.buildHash;
  if (installed !== undefined && !isOlder(installed.version, own.version) && !otherBuild) return "current";
  await deps.install(`${serverUrl}${CLI_TARBALL_PATH}`);
  return installed === undefined ? "installed" : "updated";
}

/**
 * Where the global command lives and which npm installs it. Under Volta, the `redline` on the PATH is Volta's shim, which serves the
 * package Volta keeps aside; only Volta's own npm installs there (the npm npx runs with installs into the node image instead).
 */
export function globalCommandPlace(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, platform: NodeJS.Platform = process.platform): { npm: string; packageDir?: string } {
  const volta = env.VOLTA_HOME;
  if (volta && platform !== "win32" && exists(join(volta, "bin", "npm"))) {
    return { npm: join(volta, "bin", "npm"), packageDir: join(volta, "tools", "image", "packages", "redline-cli", "lib", "node_modules", "redline-cli") };
  }
  return { npm: "npm" };
}

const readBuild = (packageDir: string): GlobalCommandBuild | undefined => {
  try {
    const version = (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string }).version;
    let hash: string | undefined;
    try {
      hash = readFileSync(join(packageDir, "build-hash.txt"), "utf8").trim();
    } catch {
      hash = undefined;
    }
    return { version, buildHash: hash };
  } catch {
    return undefined;
  }
};

export function systemGlobalCommand(env: NodeJS.ProcessEnv = process.env): GlobalCommandDeps {
  const place = globalCommandPlace(env, existsSync);
  return {
    installed: () =>
      place.packageDir !== undefined
        ? Promise.resolve(readBuild(place.packageDir))
        : new Promise((resolve) => {
            // The global packages folder; the package may be missing from it.
            execFile(place.npm, ["root", "-g"], { shell: process.platform === "win32" }, (error, stdout) => resolve(error ? undefined : readBuild(join(stdout.trim(), "redline-cli"))));
          }),
    install: (tarballUrl) => npmInstall(tarballUrl, undefined, place.npm),
  };
}
