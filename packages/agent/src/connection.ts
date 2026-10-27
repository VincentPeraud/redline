import { buildHash as ownBuildHash } from "./build-hash.js";
import {
  AGENT_ENDPOINT,
  AgentCloseCode,
  type Effort,
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentKind,
  type AgentToServerMessage,
  type ServerToAgentMessage,
} from "@redline/shared";

export interface ConnectOptions {
  serverUrl: string;
  token: string;
  machine: string;
  folder: string;
  kind: AgentKind;
  /** The project a project agent serves. */
  projectId?: string;
  /** Default model and effort for the agent's runs; absent = Claude Code's own configuration. */
  model?: string;
  effort?: Effort;
  /** Overridable for tests; defaults to this build's protocol version. */
  protocolVersion?: number;
  /** Overridable for tests; defaults to the hash of this CLI build. */
  buildHash?: string;
  /** Called for every message after the welcome (work items). */
  onMessage?(message: ServerToAgentMessage): void;
}

export interface AgentConnection {
  agentId: string;
  /** The server runs another CLI build than this one. */
  outdated: boolean;
  /** Resolves when the connection ends; `unauthorized` means the token is no longer valid. */
  closed: Promise<{ reason: "unauthorized" | "closed" }>;
  send(message: AgentToServerMessage): void;
  close(): void;
}

/** The server could not be reached at all (down, restarting, wrong address): worth retrying, unlike a refusal by the server. */
export class ServerUnreachableError extends Error {}

/** Opens the persistent outbound connection. Rejects with the server's message if it refuses the agent. */
export function connectToServer(options: ConnectOptions): Promise<AgentConnection> {
  const socket = new WebSocket(options.serverUrl.replace(/^http/, "ws") + AGENT_ENDPOINT);
  const closed = new Promise<{ reason: "unauthorized" | "closed" }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ reason: event.code === AgentCloseCode.Unauthorized ? "unauthorized" : "closed" }),
    );
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new ServerUnreachableError(`Cannot reach the server at ${options.serverUrl}.`)));
    socket.addEventListener("open", () => {
      const hello: AgentHello = {
        type: "hello",
        token: options.token,
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        machine: options.machine,
        folder: options.folder,
        kind: options.kind,
        projectId: options.projectId,
        model: options.model,
        effort: options.effort,
        buildHash: options.buildHash ?? ownBuildHash(),
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerToAgentMessage;
      if (message.type === "error") return reject(new Error(message.message));
      if (message.type === "welcome") {
        resolve({ agentId: message.agentId, outdated: message.outdated === true, closed, send: (m) => socket.send(JSON.stringify(m)), close: () => socket.close() });
      } else options.onMessage?.(message);
    });
  });
}
