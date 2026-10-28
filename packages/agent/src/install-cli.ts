import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Runs the command that installs the CLI served by the agent's server; rejects with the tail of its error output. */
export type InstallCli = (command: string) => Promise<void>;

/**
 * The npm prefix this CLI is installed under (`<prefix>/lib/node_modules/redline-cli`, `<prefix>/node_modules/redline-cli` on Windows),
 * or undefined when it runs from the sources. The update goes there: the `npm` found on the PATH may install elsewhere
 * (under Volta, the agent's PATH leads to the node image's npm, not to the folder `redline` runs from).
 */
export function installPrefix(packageDir = fileURLToPath(new URL("..", import.meta.url))): string | undefined {
  const parent = dirname(packageDir);
  if (basename(parent) !== "node_modules") return undefined;
  const above = dirname(parent);
  return process.platform !== "win32" && basename(above) === "lib" ? dirname(above) : above;
}

/**
 * The command is `cliUpdateCommand(serverUrl)` (words separated by spaces, URL validated at setup), completed with `--prefix`:
 * it runs without a shell, except on Windows where `npm` is a script.
 */
export const installCli = (command: string, prefix = installPrefix()): Promise<void> =>
  new Promise((resolve, reject) => {
    const shell = process.platform === "win32";
    const [file, ...args] = command.split(" ");
    if (prefix) args.push("--prefix", shell ? `"${prefix}"` : prefix);
    const child = spawn(file, args, { shell, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => void (errors = (errors + chunk.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `${command} exited with code ${code}`))));
  });
