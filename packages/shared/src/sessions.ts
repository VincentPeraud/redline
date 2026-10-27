import type { AgentKind } from "./index.js";
import type { Person } from "./people.js";
import type { ModelChoice, QueueReason, ThreadContext } from "./work.js";

export type SessionKind = "thread" | "conversation";

/** Where a session stands, derived from its thread or conversation, its latest run and the page queue. */
export type SessionStatus =
  | "running"
  | "queued"
  | "waiting-agent"
  | "held"
  | "answered"
  | "resolved"
  | "archived"
  | "failed"
  | "idle";

/** Filters of the Sessions screen; `all` shows everything. */
export const SESSION_FILTERS = ["all", "running", "waiting", "answered", "resolved", "failed"] as const;
export type SessionFilter = (typeof SESSION_FILTERS)[number];

const FILTER_STATUSES: Record<Exclude<SessionFilter, "all">, readonly SessionStatus[]> = {
  running: ["running"],
  waiting: ["queued", "waiting-agent", "held"],
  answered: ["answered"],
  resolved: ["resolved", "archived"],
  failed: ["failed"],
};

export function sessionMatchesFilter(status: SessionStatus, filter: SessionFilter): boolean {
  return filter === "all" || FILTER_STATUSES[filter].includes(status);
}

/** One row of the Sessions screen: a thread or a conversation. `id` is the thread or conversation id. */
export interface SessionRow extends ModelChoice {
  id: string;
  kind: SessionKind;
  name: string;
  projectId: string;
  projectTitle: string;
  pageId: string;
  pageTitle: string;
  status: SessionStatus;
  /** The agent running the session, else the project's agent; absent when none. */
  agent?: { id: string; machine: string; folder: string; kind: AgentKind };
  /** Engine session id; absent until the first run was sent. */
  sessionId?: string;
  context?: ThreadContext;
  /** Why the session waits, when `status` is "queued" or "waiting-agent". */
  waitingReason?: QueueReason | "retrying";
  /** ISO time of the latest message. */
  activityAt: string;
}

export interface SessionMessage {
  author: "user" | "claude";
  /** The person who wrote a user message; absent when none is known. */
  person?: Person;
  body: string;
  createdAt: string;
}

/** `GET /api/sessions/:id` */
export interface SessionDetail extends SessionRow {
  messages: SessionMessage[];
}

/** `GET /api/sessions` -> SessionRow[] (most recent activity first). */
export const SESSIONS_PATH = "/api/sessions";
