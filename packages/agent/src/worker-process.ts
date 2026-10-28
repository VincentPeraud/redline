import { spawn } from "node:child_process";
import type { HostToWorker, WorkerToHost } from "./host-protocol.js";

export interface WorkerCommand {
  command: string;
  args: string[];
}

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The process could not be started or signalled. */
  error?: Error;
  /** The last words the process wrote on its error output (bounded). */
  stderrTail: string;
}

export interface WorkerProcess {
  /** Sends a message on the parent channel, if it is still open. */
  send(message: HostToWorker): void;
  /** Asks the worker to stop and resolves once it has exited; it is killed when it takes longer than `timeoutMs`. */
  stop(timeoutMs: number): Promise<void>;
  /** Resolves once the process exited and every message it sent has been delivered, so the host's log is complete. */
  exited: Promise<WorkerExit>;
}

const STDERR_TAIL = 2000;

/** The process half of a worker's life: start it with an environment, relay its messages, tell how it ended. */
export function spawnWorker({ command, args }: WorkerCommand, env: NodeJS.ProcessEnv, onMessage: (message: WorkerToHost) => void): WorkerProcess {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe", "ipc"], env });
  let stderrTail = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
  });
  child.on("message", onMessage);
  const exited = new Promise<WorkerExit>((resolve) => {
    let done = false;
    let exit: Pick<WorkerExit, "code" | "signal"> | undefined;
    let disconnected = false;
    const finish = (result: Pick<WorkerExit, "code" | "signal" | "error">) => {
      if (done) return;
      done = true;
      resolve({ ...result, stderrTail });
    };
    // The channel closes after every message the worker sent has been read: finish only then.
    const settle = () => {
      if (exit && disconnected) finish(exit);
    };
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      settle();
    });
    child.on("disconnect", () => {
      disconnected = true;
      settle();
    });
    child.on("error", (error) => finish({ code: null, signal: null, error }));
  });
  return {
    send(message) {
      if (child.connected) child.send(message);
    },
    async stop(timeoutMs) {
      this.send({ type: "stop" });
      const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      await exited;
      clearTimeout(killer);
    },
    exited,
  };
}
