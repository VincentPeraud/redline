import type { FastifyInstance } from "fastify";
import {
  SESSIONS_PATH,
  type AgentInfo,
  type SessionDetail,
  type SessionMessage,
  type SessionRow,
  type SessionStatus,
  type ThreadRun,
} from "@redline/shared";
import type { Access } from "./access.js";
import type { PageLock } from "./page-lock.js";
import type { SessionOrigin, Store } from "./store.js";

interface Derived extends Pick<SessionRow, "name" | "sessionId" | "model" | "effort" | "context" | "activityAt"> {
  agentId?: string;
  terminal?: true;
  workId?: string;
  threadId?: string;
  messages: SessionMessage[];
  /** Status when no run or queue entry says otherwise. */
  idleStatus: SessionStatus;
}

/**
 * The Sessions screen: every thread and conversation as one row (type, project and page, status,
 * agent, session id, model, effort, context, activity), and the messages of one row.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  store: Store,
  lock: PageLock,
  runs: Map<string, ThreadRun>,
  lastConversationWork: Map<string, string>,
  access: Access,
): void {
  function derive(origin: SessionOrigin): Derived | undefined {
    if (origin.kind === "thread") {
      const thread = store.getThread(origin.id);
      if (!thread) return undefined;
      const session = store.getThreadSession(thread.id);
      const messages: SessionMessage[] = [
        { author: "user", ...(thread.person ? { person: thread.person } : {}), body: thread.body, createdAt: origin.createdAt },
        ...thread.replies.map((r): SessionMessage => ({ author: r.author, ...(r.person ? { person: r.person } : {}), body: r.body, createdAt: r.createdAt })),
      ];
      const idleStatus: SessionStatus =
        thread.status === "resolved"
          ? "resolved"
          : thread.status === "held" || thread.status === "review"
            ? "held"
            : thread.replies.some((r) => r.author === "claude")
              ? "answered"
              : "waiting-agent";
      return {
        name: thread.title,
        sessionId: session?.sessionId,
        agentId: session?.agentId,
        ...(store.getThreadTerminalSession(thread.id) ? { terminal: true as const } : {}),
        model: thread.context?.model,
        effort: thread.context?.effort,
        context: thread.context,
        threadId: thread.id,
        messages,
        activityAt: messages[messages.length - 1].createdAt,
        idleStatus,
      };
    }
    const conversation = store.getConversation(origin.id);
    if (!conversation) return undefined;
    const session = store.getConversationSession(conversation.id);
    const context = store.getConversationContext(conversation.id);
    const stored = store.conversationMessages(conversation.id);
    const lastUser = [...stored].reverse().find((m) => m.author === "user");
    const messages = stored.map((m): SessionMessage => ({ author: m.author, ...(m.person ? { person: m.person } : {}), body: m.body, createdAt: m.createdAt }));
    const idleStatus: SessionStatus = conversation.archived
      ? "archived"
      : stored.some((m) => m.author === "claude")
        ? "answered"
        : lastUser
          ? "waiting-agent"
          : "idle";
    return {
      name: conversation.title,
      sessionId: session?.sessionId,
      agentId: session?.agentId,
      model: context?.model ?? lastUser?.model,
      effort: context?.effort ?? lastUser?.effort,
      context,
      workId: lastConversationWork.get(conversation.id),
      messages,
      activityAt: messages.length > 0 ? messages[messages.length - 1].createdAt : conversation.createdAt,
      idleStatus,
    };
  }

  function toRow(origin: SessionOrigin, agents: Map<string, AgentInfo>): { row: SessionRow; messages: SessionMessage[] } | undefined {
    const d = derive(origin);
    if (!d) return undefined;
    const queued = lock.waiting(origin.pageId).find((e) => (d.threadId ? e.threadIds.includes(d.threadId) : e.workId === d.workId));
    const run = d.threadId ? [...runs.values()].reverse().find((r) => r.threadIds.includes(d.threadId!)) : d.workId ? runs.get(d.workId) : undefined;

    let status = d.idleStatus;
    let waitingReason: SessionRow["waitingReason"];
    if (status !== "resolved" && status !== "archived") {
      if (queued) {
        status = queued.reason === "agent-offline" ? "waiting-agent" : "queued";
        // A design system has no folder of its own: its work waits for the agent of a project using it.
        waitingReason = queued.reason === "agent-offline" && store.isDesignSystemProject(origin.projectId) ? "design-system-agent-offline" : queued.reason;
      } else if (run?.status === "sent" || run?.status === "running") {
        status = "running";
      } else if (run?.status === "retrying") {
        status = "queued";
        waitingReason = "retrying";
      } else if (run?.status === "failed") {
        status = "failed";
      } else if (run?.status === "answered") {
        status = "answered";
      }
    }

    const agentId = d.agentId ?? store.projectAgentId(origin.projectId);
    const agent = agentId ? agents.get(agentId) : undefined;
    const row: SessionRow = {
      id: origin.id,
      kind: origin.kind,
      name: d.name,
      projectId: origin.projectId,
      projectTitle: origin.projectTitle,
      pageId: origin.pageId,
      pageTitle: origin.pageTitle,
      status,
      activityAt: d.activityAt,
      ...(d.messages[0]?.person ? { startedBy: d.messages[0].person } : {}),
      ...(agent ? { agent: { id: agent.id, machine: agent.machine, folder: agent.folder, kind: agent.kind } } : {}),
      ...(d.sessionId ? { sessionId: d.sessionId } : {}),
      ...(d.terminal ? { terminal: true as const } : {}),
      ...(d.model ? { model: d.model } : {}),
      ...(d.effort ? { effort: d.effort } : {}),
      ...(d.context ? { context: d.context } : {}),
      ...(waitingReason ? { waitingReason } : {}),
    };
    return { row, messages: d.messages };
  }

  const agentsById = () => new Map(store.listAgents().map((a) => [a.id, a]));

  app.get(SESSIONS_PATH, async (req): Promise<SessionRow[]> => {
    const agents = agentsById();
    return store
      .listSessionOrigins()
      .filter((origin) => access.may(req.viewer, "read", { projectId: origin.projectId }))
      .flatMap((origin) => toRow(origin, agents)?.row ?? [])
      .sort((a, b) => b.activityAt.localeCompare(a.activityAt));
  });

  app.get<{ Params: { id: string } }>(`${SESSIONS_PATH}/:id`, async (req, reply) => {
    const origin = store.listSessionOrigins().find((o) => o.id === req.params.id && access.may(req.viewer, "read", { projectId: o.projectId }));
    const found = origin && toRow(origin, agentsById());
    if (!found) return reply.code(404).send({ error: "session not found" });
    const detail: SessionDetail = { ...found.row, messages: found.messages };
    return detail;
  });
}
