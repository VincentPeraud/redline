import type { Effort } from "@redline/shared";
import type { AgentActivity } from "./activity.js";

/**
 * What an agent is doing: `running` a piece of work (see `HostAgent.page`), `idle` (connected, waiting for work), `reconnecting`
 * (its worker is up but not connected to the server: starting, or connection lost), or `stopped` (never started in this host,
 * stopped, failed or refused).
 */
export type HostAgentState = "running" | "idle" | "reconnecting" | "stopped";

/** What the host knows of an agent; also what it persists in its registry. */
export interface HostAgent {
  id: string;
  /** The folder's base name, `global` for a global agent. */
  name: string;
  folder: string;
  kind: "project" | "global";
  serverUrl: string;
  projectIds?: string[];
  /** Titles of the projects, as the launching terminal knew them (shown by the agents screen). */
  projectNames?: string[];
  model?: string;
  effort?: Effort;
  /** The Claude config directory of the terminal that launched the agent: its worker runs with it. */
  claudeConfigDir: string;
  /** Email of the Claude account of that config directory, when known. */
  account?: string;
  state: HostAgentState;
  /** ISO time of the last state change. */
  since: string;
  /** ISO time the current worker started: the agent's uptime counts from it, `since` changes at each state change. */
  startedAt?: string;
  /** Short name of the machine the worker runs on. */
  machine?: string;
  /** The page of the run in progress, while the agent is `running`. */
  page?: string;
  /** Why the agent is stopped, when it did not stop on request (refused by the server, crashed). */
  reason?: string;
}

/** What a client gives to start an agent. The token is not part of it: the host reads it from the config directory's logins. */
export interface LaunchSettings {
  folder: string;
  kind: "project" | "global";
  serverUrl: string;
  projectIds?: string[];
  projectNames?: string[];
  model?: string;
  effort?: Effort;
  claudeConfigDir: string;
  account?: string;
}

/**
 * Control API: newline-delimited JSON on the host's Unix socket. A client sends requests, each with a numeric `id`;
 * the host answers each one with a reply carrying the same `id`. After `subscribe`, the host also pushes events.
 * Later commands (`remove`, `restart`, `restart-all`, `set-model-effort`) are new request types in this union.
 */
export type HostRequest =
  | { type: "list" }
  | ({ type: "launch" } & LaunchSettings)
  /** Keeps the host alive while the connection is open, and returns the agent. */
  | { type: "attach"; agentId: string }
  | { type: "stop"; agentId: string }
  /** The last `lines` entries (default: all that are kept) of the agent's log, oldest first. */
  | { type: "log"; agentId: string; lines?: number }
  /** Keeps the host alive while the connection is open, and streams `HostEvent`s. */
  | { type: "subscribe" };

export type HostRequestEnvelope = HostRequest & { id: number };

export type HostReply =
  | { id: number; ok: true; agents?: HostAgent[]; agent?: HostAgent; started?: boolean; entries?: HostLogEntry[] }
  | { id: number; ok: false; error: string };

/** What an agent's run log records: the worker's activity, plus the failure of a worker that did not stop on request. */
export type HostLogEvent = AgentActivity | { type: "stopped"; reason: "failed"; error: string };

/** One line of an agent's run log: the event as structured data (the agents screen formats and colours it), and when it happened. */
export interface HostLogEntry {
  /** ISO time the host received the event. */
  at: string;
  event: HostLogEvent;
}

/** Pushed to subscribers; distinguished from replies by the `event` key. */
export type HostEvent =
  | { event: "agent-added"; agent: HostAgent }
  | { event: "agent-changed"; agent: HostAgent }
  | { event: "agent-removed"; agentId: string }
  | { event: "log-line"; agentId: string; entry: HostLogEntry };

/** Host to worker, over the parent channel. */
export type HostToWorker =
  /** First message: everything the worker needs (the token included, so it never appears in a command line or environment). */
  | { type: "start"; config: WorkerConfig }
  /** Closes the connection, cancels the run in progress, and exits. */
  | { type: "stop" };

/** Worker to host. Exit code 0 is a stop, `UPDATE_EXIT_CODE` an installed update (relaunch), anything else a failure. */
export type WorkerToHost =
  /** Each activity event of the agent loop, in order. */
  | { type: "activity"; event: AgentActivity }
  /** The agent cannot run (refused by the server, wrong token...): the host shows it stopped with this reason. */
  | { type: "failed"; reason: string };

export interface WorkerConfig {
  serverUrl: string;
  token: string;
  machine: string;
  folder: string;
  kind: "project" | "global";
  projectIds?: string[];
  model?: string;
  effort?: Effort;
}

export const hostSocketPath = (configDir: string) => `${configDir}/agent-host.sock`;
export const hostLockPath = (configDir: string) => `${configDir}/agent-host.lock`;
export const agentLogPath = (configDir: string, agentId: string) => `${configDir}/logs/${agentId}.jsonl`;
export const registryPath = (configDir: string) => `${configDir}/agents.json`;
