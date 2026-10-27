import { spawn } from "node:child_process";

/** Exit code of a worker that installed an update and wants to be relaunched. */
export const UPDATE_EXIT_CODE = 75;

/** Set in the worker's environment so that `redline agent` runs the agent itself instead of supervising it. */
export const WORKER_ENV = "REDLINE_AGENT_WORKER";

/** Set on a relaunch after an update: the worker does not ask again what its first launch already settled. */
export const RELAUNCHED_ENV = "REDLINE_AGENT_RELAUNCHED";

/**
 * Runs the agent as a worker process with the same arguments, and starts it again each time it exits with
 * `UPDATE_EXIT_CODE` (it just reinstalled the CLI, so the new files are the ones that run). Any other exit ends the supervision.
 */
export async function superviseAgent({ command, args, log }: { command: string; args: string[]; log(message: string): void }): Promise<number> {
  for (let relaunched = false; ; relaunched = true) {
    const code = await runWorker(command, args, relaunched);
    if (code !== UPDATE_EXIT_CODE) return code;
    log("Agent updated, restarting it.");
  }
}

function runWorker(command: string, args: string[], relaunched: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, [WORKER_ENV]: "1", ...(relaunched ? { [RELAUNCHED_ENV]: "1" } : {}) } });
    // Ctrl-C reaches the worker too (same terminal group): the supervisor just waits for it. A termination is forwarded.
    const forward = () => child.kill("SIGTERM");
    const ignore = () => undefined;
    process.on("SIGTERM", forward);
    process.on("SIGINT", ignore);
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGTERM", forward);
      process.off("SIGINT", ignore);
      resolve(code ?? 1);
    });
  });
}
