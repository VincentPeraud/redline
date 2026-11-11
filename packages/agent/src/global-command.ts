import { execFile } from "node:child_process";
import { CLI_TARBALL_PATH } from "@redline/shared";
import { isOlder } from "./installations.js";
import { npmInstall } from "./install-cli.js";

/**
 * Whether this process was started by `npx` (the web panel's `npx -y <server>/cli/redline-cli.tgz setup ...`) and not typed against
 * the global command: npm sets `npm_command=exec` for what `npx` runs, and the package then lives in npx's `_npx` cache.
 */
export const launchedThroughNpx = (env: NodeJS.ProcessEnv, packageDir: string): boolean => env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(packageDir);

export interface GlobalCommandDeps {
  /** Version of the `redline-cli` package installed globally; undefined when there is none. */
  installedVersion(): Promise<string | undefined>;
  /** `npm i -g` of the tarball the server serves. */
  install(tarballUrl: string): Promise<void>;
}

/** Installs the global `redline` command from this server when it is missing or older than the running build; otherwise leaves it. */
export async function ensureGlobalCommand(serverUrl: string, ownVersion: string, deps: GlobalCommandDeps): Promise<"installed" | "updated" | "current"> {
  const installed = await deps.installedVersion();
  if (installed !== undefined && !isOlder(installed, ownVersion)) return "current";
  await deps.install(`${serverUrl}${CLI_TARBALL_PATH}`);
  return installed === undefined ? "installed" : "updated";
}

export const systemGlobalCommand: GlobalCommandDeps = {
  installedVersion: () =>
    new Promise((resolve) => {
      // `npm ls` exits with 1 when the package is missing but still prints JSON.
      execFile("npm", ["ls", "-g", "--depth=0", "--json", "redline-cli"], { shell: process.platform === "win32" }, (_error, stdout) => {
        try {
          resolve((JSON.parse(stdout) as { dependencies?: { "redline-cli"?: { version?: string } } }).dependencies?.["redline-cli"]?.version);
        } catch {
          resolve(undefined);
        }
      });
    }),
  install: (tarballUrl) => npmInstall(tarballUrl, undefined),
};
