import {
  AGENT_ENDPOINT,
  AgentCloseCode,
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentKind,
  type ServerToAgentMessage,
} from "@redline/shared";

export interface ConnectOptions {
  serverUrl: string;
  token: string;
  machine: string;
  folder: string;
  kind: AgentKind;
  /** Overridable for tests; defaults to this build's protocol version. */
  protocolVersion?: number;
}

export interface AgentConnection {
  agentId: string;
  /** Resolves when the connection ends; `unauthorized` means the token is no longer valid. */
  closed: Promise<{ reason: "unauthorized" | "closed" }>;
  close(): void;
}

/** Opens the persistent outbound connection. Rejects with the server's message if it refuses the agent. */
export function connectToServer(options: ConnectOptions): Promise<AgentConnection> {
  const socket = new WebSocket(options.serverUrl.replace(/^http/, "ws") + AGENT_ENDPOINT);
  const closed = new Promise<{ reason: "unauthorized" | "closed" }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ reason: event.code === AgentCloseCode.Unauthorized ? "unauthorized" : "closed" }),
    );
  });

  return new Promise((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error(`Cannot reach the server at ${options.serverUrl}.`)));
    socket.addEventListener("open", () => {
      const hello: AgentHello = {
        type: "hello",
        token: options.token,
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        machine: options.machine,
        folder: options.folder,
        kind: options.kind,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerToAgentMessage;
      if (message.type === "error") return reject(new Error(message.message));
      if (message.type === "welcome") resolve({ agentId: message.agentId, closed, close: () => socket.close() });
    });
  });
}
