import { spawn } from "node:child_process";

/** Runs the command that installs the CLI served by the agent's server; rejects with the tail of its error output. */
export type InstallCli = (command: string) => Promise<void>;

export const installCli: InstallCli = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => void (errors = (errors + chunk.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `${command} exited with code ${code}`))));
  });
