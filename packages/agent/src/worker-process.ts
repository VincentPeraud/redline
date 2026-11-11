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
  /**
   * Asks the worker to stop only if it runs nothing; resolves false when it is busy (it goes on), true once it has exited (killed
   * after `timeoutMs`). A worker of an older build that does not know the request stays silent: it gets a plain stop.
   */
  stopWhenIdle(timeoutMs: number): Promise<boolean>;
  /** Resolves once the process exited and every message it sent has been delivered, so the host's log is complete. */
  exited: Promise<WorkerExit>;
}

const STDERR_TAIL = 2000;
/** How long a worker may take to answer `stop-when-idle` before it is taken for one that does not know it. */
const SILENCE_MS = 3000;

/** The process half of a worker's life: start it with an environment, relay its messages, tell how it ended. */
export function spawnWorker({ command, args }: WorkerCommand, env: NodeJS.ProcessEnv, onMessage: (message: Exclude<WorkerToHost, { type: "busy" }>) => void): WorkerProcess {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe", "ipc"], env });
  let stderrTail = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL);
  });
  const busyListeners = new Set<() => void>();
  child.on("message", (message: WorkerToHost) => {
    if (message.type === "busy") for (const listener of busyListeners) listener();
    else onMessage(message);
  });
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
    async stopWhenIdle(timeoutMs) {
      this.send({ type: "stop-when-idle" });
      let listener = () => undefined as void;
      let silence: NodeJS.Timeout | undefined;
      const answer = await Promise.race([
        exited.then(() => "exited" as const),
        new Promise<"busy">((resolve) => busyListeners.add((listener = () => resolve("busy")))),
        new Promise<"silent">((resolve) => (silence = setTimeout(() => resolve("silent"), SILENCE_MS))),
      ]);
      busyListeners.delete(listener);
      clearTimeout(silence);
      if (answer === "busy") return false;
      if (answer === "silent") await this.stop(timeoutMs);
      else {
        const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        await exited;
        clearTimeout(killer);
      }
      return true;
    },
    exited,
  };
}
