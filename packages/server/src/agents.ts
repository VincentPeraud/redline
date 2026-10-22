import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AGENT_ENDPOINT,
  AGENT_UPDATE_COMMAND,
  AgentCloseCode,
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentTokenResponse,
  type ServerToAgentMessage,
} from "@redline/shared";
import type { Store } from "./store.js";

function send(socket: WebSocket, message: ServerToAgentMessage): void {
  socket.send(JSON.stringify(message));
}

function parseHello(raw: string): AgentHello | undefined {
  try {
    const m = JSON.parse(raw) as Partial<AgentHello>;
    const valid =
      m.type === "hello" &&
      typeof m.token === "string" &&
      typeof m.protocolVersion === "number" &&
      typeof m.machine === "string" &&
      typeof m.folder === "string" &&
      (m.kind === "project" || m.kind === "global");
    return valid ? (m as AgentHello) : undefined;
  } catch {
    return undefined;
  }
}

/** Agent endpoint (WebSocket) plus the token and agent-list API. */
export async function registerAgentRoutes(app: FastifyInstance, store: Store): Promise<void> {
  await app.register(websocket);
  const connected = new Map<WebSocket, string>();

  app.addHook("onClose", async () => {
    for (const agentId of connected.values()) store.markAgentOffline(agentId);
    connected.clear();
  });

  app.get(AGENT_ENDPOINT, { websocket: true }, (socket) => {
    socket.once("message", (data) => {
      const hello = parseHello(data.toString());
      if (!hello) {
        send(socket, { type: "error", code: "bad_hello", message: "Expected a hello message." });
        return socket.close(AgentCloseCode.BadHello, "bad hello");
      }
      if (hello.token !== store.getAgentToken()) {
        send(socket, {
          type: "error",
          code: "unauthorized",
          message: "Wrong token. Run `redline login <server-url>` with the token shown on the Agents screen.",
        });
        return socket.close(AgentCloseCode.Unauthorized, "unauthorized");
      }
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        send(socket, {
          type: "error",
          code: "incompatible_protocol",
          message: `Agent protocol ${hello.protocolVersion} is not supported (server uses ${PROTOCOL_VERSION}). Update the agent with: ${AGENT_UPDATE_COMMAND}`,
        });
        return socket.close(AgentCloseCode.IncompatibleProtocol, "incompatible protocol");
      }
      const agentId = store.markAgentOnline(hello.machine, hello.folder, hello.kind);
      connected.set(socket, agentId);
      socket.on("close", () => {
        if (connected.delete(socket)) store.markAgentOffline(agentId);
      });
      send(socket, { type: "welcome", agentId });
    });
  });

  app.get("/api/agent-token", async (): Promise<AgentTokenResponse> => ({ token: store.getAgentToken() }));

  app.post("/api/agent-token/regenerate", async (): Promise<AgentTokenResponse> => {
    const token = store.regenerateAgentToken();
    for (const [socket, agentId] of connected) {
      connected.delete(socket);
      store.markAgentOffline(agentId);
      socket.close(AgentCloseCode.Unauthorized, "token regenerated");
    }
    return { token };
  });

  app.get("/api/agents", async () => store.listAgents());
}
