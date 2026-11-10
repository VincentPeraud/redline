import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  AGENT_ENDPOINT,
  AgentCloseCode,
  cliUpdateCommand,
  EFFORTS,
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentUpdateFailedMessage,
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
      (m.projectIds === undefined || (Array.isArray(m.projectIds) && m.projectIds.every((id) => typeof id === "string"))) &&
      (m.buildHash === undefined || typeof m.buildHash === "string") &&
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

function parseUpdateFailure(raw: string): AgentUpdateFailedMessage | undefined {
  try {
    const m = JSON.parse(raw) as Partial<AgentUpdateFailedMessage>;
    return m.type === "update-failed" && typeof m.message === "string" ? (m as AgentUpdateFailedMessage) : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentHub {
  /** Sends a message to a connected agent; false when that agent is not connected. */
  send(agentId: string, message: ServerToAgentMessage): boolean;
  /** Calls `listener` once an agent has been welcomed and can receive work. */
  onAgentOnline(listener: (agentId: string) => void): void;
  /** Only work messages for which `owns(agentId, workId)` is true are relayed: an agent cannot report on another agent's work. */
  acceptWorkMessagesFrom(owns: (agentId: string, workId: string) => boolean): void;
  /** Closes the connections of the agents a person launched (their token was revoked or regenerated). */
  disconnectPerson(personId: string): void;
  /** Calls `listener` when an agent's connection ended (closed, or dropped by a token regeneration). */
  onAgentOffline(listener: (agentId: string) => void): void;
}

/** Agent endpoint (WebSocket) plus the token and agent-list API. */
export async function registerAgentRoutes(app: FastifyInstance, store: Store): Promise<AgentHub> {
  await app.register(websocket);
  const connected = new Map<WebSocket, { agentId: string; personId?: string }>();
  const onlineListeners: ((agentId: string) => void)[] = [];
  const offlineListeners: ((agentId: string) => void)[] = [];
  let ownsWork: (agentId: string, workId: string) => boolean = () => true;

  function sendToAgent(agentId: string, message: ServerToAgentMessage): boolean {
    for (const [socket, { agentId: id }] of connected) {
      if (id === agentId) {
        send(socket, message);
        return true;
      }
    }
    return false;
  }

  app.addHook("onClose", async () => {
    for (const { agentId } of connected.values()) store.markAgentOffline(agentId);
    connected.clear();
  });

  app.get(AGENT_ENDPOINT, { websocket: true }, (socket, request) => {
    const origin = `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host}`;
    socket.once("message", (data) => {
      const hello = parseHello(data.toString());
      if (!hello) {
        send(socket, { type: "error", code: "bad_hello", message: "Expected a hello message." });
        return socket.close(AgentCloseCode.BadHello, "bad hello");
      }
      const actor = store.accounts.agentActorOf(hello.token);
      if (!actor) {
        send(socket, {
          type: "error",
          code: "unauthorized",
          message: "Wrong token. Run `redline setup <server-url> --token <token>` with the token shown on the Agents screen.",
        });
        return socket.close(AgentCloseCode.Unauthorized, "unauthorized");
      }
      if (hello.protocolVersion !== PROTOCOL_VERSION) {
        store.recordRefusedAgent(hello);
        store.emit({ type: "agents-updated" });
        send(socket, {
          type: "error",
          code: "incompatible_protocol",
          message: `Agent protocol ${hello.protocolVersion} is not supported (server uses ${PROTOCOL_VERSION}). Update the agent with: ${cliUpdateCommand(origin)}`,
        });
        return socket.close(AgentCloseCode.IncompatibleProtocol, "incompatible protocol");
      }
      const projectIds = [...new Set(hello.projectIds ?? (hello.projectId !== undefined ? [hello.projectId] : []))];
      const missing = projectIds.filter((id) => !store.projectExists(id));
      if (missing.length > 0) {
        send(socket, {
          type: "error",
          code: "unknown_project",
          message: `This folder is linked to a project that no longer exists (${missing.join(", ")}). Run \`redline agent\` again: it drops it from the folder's link.`,
        });
        return socket.close(AgentCloseCode.UnknownProject, "unknown project");
      }
      for (const projectId of projectIds) {
        const other = store.findOtherOnlineProjectAgent(projectId, hello.machine, hello.folder);
        if (other) {
          const title = projectIds.length > 1 ? `"${store.getProject(projectId)?.title}"` : "This project";
          send(socket, {
            type: "error",
            code: "project_taken",
            message: `${title} is already served by the agent on ${other.machine} (${other.folder}). Stop it first.`,
          });
          return socket.close(AgentCloseCode.ProjectTaken, "project taken");
        }
      }
      const personId = actor.account?.id;
      const agentId = store.markAgentOnline({ ...hello, projectIds, personId });
      connected.set(socket, { agentId, personId });
      store.emit({ type: "agents-updated" });
      socket.on("close", () => {
        if (!connected.delete(socket)) return;
        store.markAgentOffline(agentId);
        store.emit({ type: "agents-updated" });
        for (const listener of offlineListeners) listener(agentId);
      });
      socket.on("message", (data) => {
        const failure = parseUpdateFailure(data.toString());
        if (failure) {
          store.recordUpdateFailure(agentId, failure.message);
          store.emit({ type: "agents-updated" });
          for (const listener of onlineListeners) listener(agentId);
          return;
        }
        const message = parseWorkMessage(data.toString());
        if (message && ownsWork(agentId, message.workId)) store.emit({ type: "work", message });
      });
      send(socket, { type: "welcome", agentId, ...(store.isOutdated(hello.buildHash) ? { outdated: true } : {}) });
      for (const listener of onlineListeners) listener(agentId);
    });
  });

  function disconnect(accepts: (personId: string | undefined) => boolean): void {
    for (const [socket, { agentId, personId }] of connected) {
      if (!accepts(personId)) continue;
      connected.delete(socket);
      store.markAgentOffline(agentId);
      store.emit({ type: "agents-updated" });
      socket.close(AgentCloseCode.Unauthorized, "token revoked");
      for (const listener of offlineListeners) listener(agentId);
    }
  }

  // Everyone has their own token; without accounts (mode none) there is only the shared one.
  app.get("/api/agent-token", async (req): Promise<AgentTokenResponse> => ({ token: req.person ? store.accounts.agentTokenOf(req.person.id) : store.getAgentToken() }));

  app.post("/api/agent-token/regenerate", async (req): Promise<AgentTokenResponse> => {
    if (req.person) {
      const token = store.accounts.regenerateAgentToken(req.person.id);
      disconnect((personId) => personId === req.person!.id);
      return { token };
    }
    const token = store.regenerateAgentToken();
    disconnect(() => true);
    return { token };
  });

  app.get("/api/agents", async () => store.listAgents());

  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/update", async (req, reply) => {
    const { agentId } = req.params;
    if (!sendToAgent(agentId, { type: "update" })) return reply.code(404).send({ error: "This agent is not connected." });
    store.markAgentUpdating(agentId);
    store.emit({ type: "agents-updated" });
    return reply.code(202).send();
  });

  return {
    onAgentOnline: (listener) => void onlineListeners.push(listener),
    onAgentOffline: (listener) => void offlineListeners.push(listener),
    acceptWorkMessagesFrom: (owns) => void (ownsWork = owns),
    disconnectPerson: (personId) => disconnect((owner) => owner === personId),
    send: sendToAgent,
  };
}
