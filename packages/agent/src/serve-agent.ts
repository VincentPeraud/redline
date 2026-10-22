import { startAgent, type AgentOptions } from "./agent.js";
import { ServerUnreachableError } from "./connection.js";

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface ServeAgentOptions extends AgentOptions {
  /** Waits between attempts while the server is unreachable or the connection was lost; the last one repeats. */
  reconnectDelaysMs?: number[];
  /** Progress messages ("Connected...", "Connection lost, retrying..."). */
  log?(message: string): void;
}

export interface AgentService {
  /** Closes the connection and stops retrying. */
  stop(): void;
  /** Resolves after `stop()`; rejects when the server refuses the agent (wrong token, incompatible protocol, unknown project...). */
  done: Promise<void>;
}

/**
 * Keeps an agent connected: it connects, and when the server goes away or cannot be reached it retries
 * with a growing delay, so the agent survives a server restart. A refusal by the server is final.
 */
export function serveAgent({ reconnectDelaysMs = RECONNECT_DELAYS_MS, log = () => undefined, ...options }: ServeAgentOptions): AgentService {
  let stopped = false;
  let wake: () => void = () => undefined;
  let current: { close(): void } | undefined;

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run(): Promise<void> {
    let failures = 0;
    while (!stopped) {
      try {
        const connection = await startAgent(options);
        current = connection;
        failures = 0;
        log(`Connected to ${options.serverUrl} as ${options.kind} agent in ${options.folder}. Ctrl-C to stop.`);
        const { reason } = await connection.closed;
        if (reason === "unauthorized") throw new Error("The token was regenerated. Run `redline login <server-url>` again.");
        if (stopped) return;
        log("Connection lost, retrying...");
      } catch (error) {
        if (!(error instanceof ServerUnreachableError)) throw error;
        log(`${error.message} Retrying...`);
      }
      if (stopped) return;
      await pause(reconnectDelaysMs[Math.min(failures, reconnectDelaysMs.length - 1)]);
      failures += 1;
    }
  }

  return {
    stop() {
      stopped = true;
      current?.close();
      wake();
    },
    done: run(),
  };
}
