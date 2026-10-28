import type { AgentKind } from "@redline/shared";
import { sanitizeForTerminal } from "./sanitize.js";

/** What an agent reports about itself, as structured events: the foreground prints them, the agent host logs them. */
export type AgentActivity =
  | { type: "connected"; serverUrl: string; kind: AgentKind; folder: string }
  /** The connection ended or the server cannot be reached (`reason` then says why); the agent keeps retrying. */
  | { type: "connection-lost"; reason?: string }
  | { type: "reconnected" }
  /** The server refused the agent (regenerated token, unknown project, incompatible protocol...); final. */
  | { type: "refused"; reason: string }
  /** `attempt` is 2 or more when the server sent again a work item that failed. */
  | { type: "run-started"; workId: string; project: string; pageId: string; page: string; kind: "comment" | "conversation" | "summary"; author?: string; excerpt?: string; attempt: number }
  /** After each engine step: the latest ones ("Edit home.html") and the time since the run started. */
  | { type: "run-progress"; workId: string; steps: string[]; elapsedMs: number }
  /** The run ended well; `changed` lists the files it published (empty: nothing changed). */
  | { type: "run-published"; workId: string; page: string; changed: string[]; durationMs: number }
  /** The server decides whether a failed run is tried again: it then sends the item again, as a `run-started` with a higher `attempt`. */
  | { type: "run-failed"; workId: string; page: string; reason: string; attempt: number }
  | { type: "stopped"; reason: "stopped" | "updated" };

export type ReportActivity = (event: AgentActivity) => void;

/** The wording the foreground lines and the agents screen's log share. */
export const wording = {
  connected: (serverUrl: string, kind: AgentKind) => `Connected to ${serverUrl} as ${kind} agent`,
  connectionLost: (reason?: string) => (reason ? `${reason} Retrying...` : "Connection lost, retrying..."),
  reconnected: "Connected again.",
};

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** One plain English line for an event, safe to print on a terminal. */
export const formatActivity = (event: AgentActivity): string => sanitizeForTerminal(describe(event));

function describe(event: AgentActivity): string {
  switch (event.type) {
    case "connected":
      return `${wording.connected(event.serverUrl, event.kind)} in ${event.folder}. Ctrl-C to stop.`;
    case "connection-lost":
      return wording.connectionLost(event.reason);
    case "reconnected":
      return wording.reconnected;
    case "refused":
      return `Refused by the server: ${event.reason}`;
    case "run-started": {
      const who = event.author ? ` for ${event.author}` : "";
      const retry = event.attempt > 1 ? `, attempt ${event.attempt}` : "";
      const quote = event.excerpt ? `: "${event.excerpt}"` : "";
      return `Run started on ${event.project} / ${event.page} (${event.kind})${who}${retry}${quote}`;
    }
    case "run-progress":
      return `Working (${seconds(event.elapsedMs)}): ${event.steps.at(-1) ?? "thinking"}`;
    case "run-published":
      return event.changed.length > 0
        ? `Run published on ${event.page} in ${seconds(event.durationMs)}: ${event.changed.join(", ")}`
        : `Run finished on ${event.page} in ${seconds(event.durationMs)}, nothing changed`;
    case "run-failed":
      return `Run failed: ${event.reason}`;
    case "stopped":
      return event.reason === "updated" ? "Agent updated, restarting." : "Agent stopped.";
  }
}
