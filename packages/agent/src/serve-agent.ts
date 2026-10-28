import { cliUpdateCommand, type ModelChoice } from "@redline/shared";
import { formatActivity, type AgentActivity } from "./activity.js";
import { startAgent, type AgentOptions } from "./agent.js";
import { ServerUnreachableError } from "./connection.js";

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

export interface ServeAgentOptions extends Omit<AgentOptions, "onUpdated"> {
  /** Waits between attempts while the server is unreachable or the connection was lost; the last one repeats. */
  reconnectDelaysMs?: number[];
  /** Receives every activity event (connection, runs, stop). */
  onActivity?(event: AgentActivity): void;
  /** One plain English line per activity event ("Connected...", "Connection lost, retrying..."), plus the outdated warning. */
  log?(message: string): void;
}

export interface AgentService {
  /** Closes the connection and stops retrying. */
  stop(): void;
  /** The model and effort of the work items to come that carry none of their own, now and after a reconnection. A run in progress keeps its own. */
  setModelEffort(choice: ModelChoice): void;
  /**
   * Resolves after `stop()`, or once an update was installed (`updated`: the caller exits so that its supervisor relaunches it);
   * rejects when the server refuses the agent (wrong token, incompatible protocol, unknown project...).
   */
  done: Promise<{ updated: boolean }>;
}

/**
 * Keeps an agent connected: it connects, and when the server goes away or cannot be reached it retries
 * with a growing delay, so the agent survives a server restart. A refusal by the server is final.
 */
export function serveAgent({ reconnectDelaysMs = RECONNECT_DELAYS_MS, log = () => undefined, onActivity, ...options }: ServeAgentOptions): AgentService {
  let choice: ModelChoice = { model: options.model, effort: options.effort };
  let stopped = false;
  let updated = false;
  let wake: () => void = () => undefined;
  let current: { close(): void } | undefined;
  const report = (event: AgentActivity) => {
    onActivity?.(event);
    log(formatActivity(event));
  };

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run(): Promise<{ updated: boolean }> {
    let failures = 0;
    let warnedOutdated = false;
    let connectedBefore = false;
    let lostReported = false;
    while (!stopped) {
      try {
        const connection = await startAgent({
          ...options,
          ...choice,
          currentChoice: () => choice,
          onActivity: report,
          onUpdated() {
            updated = true;
            service.stop();
          },
        });
        current = connection;
        // `stop()` came while connecting: it had no connection to close yet.
        if (stopped) connection.close();
        failures = 0;
        lostReported = false;
        report(connectedBefore ? { type: "reconnected" } : { type: "connected", serverUrl: options.serverUrl, kind: options.kind, folder: options.folder });
        connectedBefore = true;
        if (connection.outdated && !warnedOutdated) {
          warnedOutdated = true;
          log(`This agent is not up to date. Update it with: ${cliUpdateCommand(options.serverUrl)}`);
        }
        const { reason } = await connection.closed;
        if (reason === "unauthorized") throw new Error("The token was regenerated. Run `redline setup <server-url> --token <token>` again with the new token from the Agents screen.");
        if (stopped) return finish();
        lostReported = true;
        report({ type: "connection-lost" });
      } catch (error) {
        if (!(error instanceof ServerUnreachableError)) {
          report({ type: "refused", reason: (error as Error).message });
          throw error;
        }
        if (!lostReported) report({ type: "connection-lost", reason: error.message });
        lostReported = true;
      }
      if (stopped) return finish();
      await pause(reconnectDelaysMs[Math.min(failures, reconnectDelaysMs.length - 1)]);
      failures += 1;
    }
    return finish();
  }

  function finish(): { updated: boolean } {
    report({ type: "stopped", reason: updated ? "updated" : "stopped" });
    return { updated };
  }

  const service: AgentService = {
    setModelEffort(next) {
      choice = next;
    },
    stop() {
      stopped = true;
      current?.close();
      wake();
    },
    done: run(),
  };
  return service;
}
