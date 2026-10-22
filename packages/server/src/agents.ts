import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AGENT_ENDPOINT,
  AGENT_UPDATE_COMMAND,
  AgentCloseCode,
  EFFORTS,
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentWorkMessage,
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
      (m.kind === "project" || m.kind === "global") &&
      (m.projectId === undefined || typeof m.projectId === "string") &&
      (m.model === undefined || typeof m.model === "string") &&
      (m.effort === undefined || (EFFORTS as readonly unknown[]).includes(m.effort));
    return valid ? (m as AgentHello) : undefined;
  } catch {
    return undefined;
  }
}

function parseWorkMessage(raw: string): AgentWorkMessage | undefined {
  try {
    const m = JSON.parse(raw) as Partial<AgentWorkMessage>;
    const known = m.type === "work-event" || m.type === "work-done" || m.type === "work-failed";
    return known && typeof m.workId === "string" ? (m as AgentWorkMessage) : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentHub {
  /** Sends a message to a connected agent; false when that agent is not connected. */
  send(agentId: string, message: ServerToAgentMessage): boolean;
}

/** Agent endpoint (WebSocket) plus the token and agent-list API. */
export async function registerAgentRoutes(app: FastifyInstance, store: Store): Promise<AgentHub> {
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
      if (hello.projectId !== undefined) {
        if (!store.projectExists(hello.projectId)) {
          send(socket, { type: "error", code: "unknown_project", message: "This folder is linked to a project that no longer exists. Run `redline init` again." });
          return socket.close(AgentCloseCode.UnknownProject, "unknown project");
        }
        const other = store.findOtherOnlineProjectAgent(hello.projectId, hello.machine, hello.folder);
        if (other) {
          send(socket, {
            type: "error",
            code: "project_taken",
            message: `This project is already served by the agent on ${other.machine} (${other.folder}). Stop it first.`,
          });
          return socket.close(AgentCloseCode.ProjectTaken, "project taken");
        }
      }
      const agentId = store.markAgentOnline(hello.machine, hello.folder, hello.kind, hello.projectId, hello.model, hello.effort);
      connected.set(socket, agentId);
      socket.on("close", () => {
        if (connected.delete(socket)) store.markAgentOffline(agentId);
      });
      socket.on("message", (data) => {
        const message = parseWorkMessage(data.toString());
        if (message) store.emit({ type: "work", message });
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

  return {
    send(agentId, message) {
      for (const [socket, id] of connected) {
        if (id === agentId) {
          send(socket, message);
          return true;
        }
      }
      return false;
    },
  };
}
