import { spawn } from "node:child_process";

/** Runs the command that installs the CLI served by the agent's server; rejects with the tail of its error output. */
export type InstallCli = (command: string) => Promise<void>;

/** The command is `cliUpdateCommand(serverUrl)` (words separated by spaces, URL validated at setup): it runs without a shell, except on Windows where `npm` is a script. */
export const installCli: InstallCli = (command) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = command.split(" ");
    const child = spawn(file, args, { shell: process.platform === "win32", stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => void (errors = (errors + chunk.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `${command} exited with code ${code}`))));
  });
