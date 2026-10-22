export const PROTOCOL_VERSION = 1;

export type PageType = "prototype" | "comparison";

export interface Project {
  id: string;
  title: string;
  /** The project agent serving it, once an agent has linked the project. */
  agent?: { id: string; machine: string; folder: string; status: AgentStatus };
}

export type VersionOrigin = "thread" | "conversation" | "terminal" | "tweak" | "restore";

export const VERSION_ORIGINS: readonly VersionOrigin[] = ["thread", "conversation", "terminal", "tweak", "restore"];

export interface PageVersionSummary {
  id: string;
  message: string;
  origin: VersionOrigin;
  createdAt: string;
}

export interface CreateVersionRequest {
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
  message: string;
  origin: VersionOrigin;
}

export interface PageVersion {
  id: string;
  /** Maps each file path of the page to the content hash of its blob. */
  files: Record<string, string>;
}

export interface Page {
  id: string;
  projectId: string;
  title: string;
  type: PageType;
  version: PageVersion;
}

export interface CreatePageRequest {
  title: string;
  type: PageType;
  /** File path -> UTF-8 content. */
  files: Record<string, string>;
}

export interface ServerConfig {
  artboardOrigin: string;
}

export type ThreadStatus = "open" | "resolved";

export interface Thread {
  id: string;
  pageId: string;
  /** Per-page number shown on the pin and in the thread list; never reused. */
  number: number;
  /** Path of the artboard file the thread is pinned on. */
  artboard: string;
  /** CSS selector of the pinned element; may stop matching after edits. */
  selector: string;
  /** Fallback position, in percent of the artboard document size. */
  xPct: number;
  yPct: number;
  /** First line of the comment, kept visible when the thread is resolved. */
  title: string;
  body: string;
  status: ThreadStatus;
}

export interface CreateThreadRequest {
  artboard: string;
  selector: string;
  xPct: number;
  yPct: number;
  body: string;
}

/** WebSocket path of the agent endpoint (outside the reverse proxy's protection; guarded by the token). */
export const AGENT_ENDPOINT = "/agent";

/** Command printed to users whose agent is too old for the server. */
export const AGENT_UPDATE_COMMAND = "npm i -g redline-cli@latest";

/** WebSocket close codes sent by the server on the agent endpoint. */
export const AgentCloseCode = {
  /** Wrong token, or token regenerated while connected. */
  Unauthorized: 4401,
  /** The agent's protocol version is not the server's. */
  IncompatibleProtocol: 4426,
  /** Malformed first message. */
  BadHello: 4400,
  /** The hello names a project that does not exist. */
  UnknownProject: 4404,
  /** Another project agent already serves the project. */
  ProjectTaken: 4409,
} as const;

export type AgentKind = "project" | "global";

/** First message an agent sends after the socket opens. */
export interface AgentHello {
  type: "hello";
  token: string;
  protocolVersion: number;
  machine: string;
  folder: string;
  kind: AgentKind;
  /** The project a project agent serves (the link recorded in its folder). */
  projectId?: string;
}

export type AgentToServerMessage = AgentHello;

/** Messages the server sends on the agent endpoint. */
export type ServerToAgentMessage =
  | { type: "welcome"; agentId: string }
  | { type: "error"; code: "unauthorized" | "incompatible_protocol" | "bad_hello" | "unknown_project" | "project_taken"; message: string };

export type AgentStatus = "online" | "offline";

export interface AgentInfo {
  id: string;
  machine: string;
  folder: string;
  kind: AgentKind;
  status: AgentStatus;
  /** ISO timestamp of the last connection or disconnection. */
  lastSeenAt: string;
}

export interface AgentTokenResponse {
  token: string;
}
