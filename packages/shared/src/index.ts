export const PROTOCOL_VERSION = 1;

export type PageType = "prototype" | "comparison";

export interface Project {
  id: string;
  title: string;
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
}

export type AgentToServerMessage = AgentHello;

/** Messages the server sends on the agent endpoint. */
export type ServerToAgentMessage =
  | { type: "welcome"; agentId: string }
  | { type: "error"; code: "unauthorized" | "incompatible_protocol" | "bad_hello"; message: string };

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
