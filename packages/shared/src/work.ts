// Engine events and work items: the contract between server, agent and engine adapters (ticket 07).

import type { ProjectContext } from "./projectFiles.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Models offered in a thread's model list (Claude Code aliases). */
export const MODEL_CHOICES = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;

/** What an engine emits while a session runs. Streamed to the server as `work-event`. */
export type EngineEvent =
  /** Claude took an action: a tool call such as a read or an edit. */
  | { type: "step"; tool: string; summary: string }
  /** A chunk of Claude's own text. */
  | { type: "text"; text: string }
  /** Token usage of the last model call. */
  | { type: "usage"; model: string; inputTokens: number; cacheTokens: number; outputTokens: number }
  /** The run ended successfully; `summary` becomes the version message. */
  | { type: "result"; summary: string }
  /** The run failed; nothing is published. */
  | { type: "error"; message: string };

/** A comment of a thread, as told to Claude. */
export interface WorkThread {
  threadId: string;
  number: number;
  artboard: string;
  selector: string;
  xPct: number;
  yPct: number;
  body: string;
}

/** One unit of work pushed by the server to the agent that serves the project. */
export interface WorkItem {
  id: string;
  kind: "thread";
  pageId: string;
  /** The threads this item answers; Claude may reply only in these. */
  threads: WorkThread[];
  /** The message sent to the engine (the agent prepends the working copy location). */
  message: string;
  /** Engine session id to start, or to resume when `resume` is true. */
  sessionId: string;
  resume: boolean;
  model?: string;
  effort?: Effort;
}

/** Messages an agent sends about a work item. */
export type AgentWorkMessage =
  | { type: "work-event"; workId: string; event: EngineEvent }
  /** Sent once the run ended and the working copy was published (`versionId` absent when nothing changed). */
  | { type: "work-done"; workId: string; versionId?: string }
  /** Sent when the run failed; nothing was published. */
  | { type: "work-failed"; workId: string; message: string };

export interface ThreadReply {
  id: string;
  author: "claude" | "user";
  body: string;
  createdAt: string;
}

export interface CreateReplyRequest {
  body: string;
  /** Model for this message; absent = the agent's default. The web form sends its current choice with every message. */
  model?: string;
  effort?: Effort;
}

/** Server-sent events on `GET /api/events`, so the web UI refreshes without polling. */
export type ServerEvent =
  | { type: "page-updated"; pageId: string; versionId: string }
  | { type: "thread-updated"; pageId: string; threadId: string }
  /** The waiting work items of the page changed (`GET /api/pages/:id/queue`). */
  | { type: "queue-updated"; pageId: string }
  /** What an agent reported about a work item, relayed as is. */
  | { type: "work"; message: AgentWorkMessage }
  /** A work item was pushed to an agent (the threads it answers are "sent"). */
  | { type: "work-dispatched"; pageId: string; workId: string; threadIds: string[] }
  /** Live state of a run, sent after every change (full snapshot, replace by `workId`). */
  | { type: "run-updated"; pageId: string; run: ThreadRun };

/** Where a thread is in its run: sent to the agent, Claude working, answered, or failed. */
export type RunStatus = "sent" | "running" | "answered" | "failed";

export interface RunStep {
  tool: string;
  summary: string;
}

/** What the web UI shows of a running (or finished) work item. Kept in server memory. */
export interface ThreadRun {
  workId: string;
  pageId: string;
  threadIds: string[];
  status: RunStatus;
  steps: RunStep[];
  /** Claude's streamed text so far. */
  text: string;
  error?: string;
}

/** `GET /api/pages/:pageId/runs` -> ThreadRun[] (oldest first). */
export const pageRunsPath = (pageId: string) => `/api/pages/${pageId}/runs`;

/** Why a work item is not running yet. */
export type QueueReason = "page-busy" | "agent-offline";

/** A work item waiting for its turn on a page. */
export interface QueueEntry {
  workId: string;
  pageId: string;
  threadIds: string[];
  reason: QueueReason;
}

export const SERVER_EVENTS_PATH = "/api/events";

/**
 * Token-guarded HTTP API for agents (`Authorization: Bearer <agent token>`). Like `/agent`, it is
 * meant to stay reachable when a reverse proxy protects `/api`.
 *   GET  /agent-api/pages/:pageId/files          -> AgentCheckout
 *   POST /agent-api/pages/:pageId/versions       (CreateVersionRequest) -> PageVersionSummary
 *   POST /agent-api/pages/:pageId/siblings       ({title, type}) -> Page, a new page in the same project
 *   POST /agent-api/threads/:threadId/replies    (CreateReplyRequest)   -> ThreadReply
 */
export const AGENT_API_PREFIX = "/agent-api";

export interface AgentCheckout {
  versionId: string;
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
  /** DESIGN.md, assets and design system of the page's project (read-only for the session). */
  project: ProjectContext;
}
