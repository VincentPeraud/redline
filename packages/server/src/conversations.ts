import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EFFORTS,
  type Conversation,
  type ConversationDetail,
  type CreateConversationMessageRequest,
  type CreateConversationRequest,
  type ServerEvent,
  type WorkItem,
} from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/** The message Claude receives for a conversation message; every message says which page is shown. */
export function conversationMessage(pageTitle: string, pageId: string, bodies: string[]): string {
  return [
    `Conversation about the page "${pageTitle}" (page id ${pageId}), the page the user is looking at. It is separate from the page's comment threads.`,
    "",
    ...bodies.flatMap((body) => [body, ""]),
    "Make the change in the working copy if the message asks for one, then answer in a short final message.",
  ].join("\n");
}

/**
 * Conversation routes and dispatch. A conversation has its own engine session (started with its
 * first message, resumed after), never shared with a thread; every message goes through the page lock.
 */
export function registerConversationRoutes(app: FastifyInstance, store: Store, lock: PageLock): void {
  const conversationOfWork = new Map<string, string>();
  const lastWorkOf = new Map<string, string>();

  const unsubscribe = store.onChange((event: ServerEvent) => {
    if (event.type !== "work" || event.message.type !== "work-event") return;
    const conversationId = conversationOfWork.get(event.message.workId);
    if (!conversationId) return;
    const engineEvent = event.message.event;
    if (engineEvent.type === "usage") {
      store.setConversationContextTokens(conversationId, engineEvent.inputTokens + engineEvent.cacheTokens + engineEvent.outputTokens);
    } else if (engineEvent.type === "result" && engineEvent.summary.trim() !== "") {
      store.addConversationMessage(conversationId, "claude", engineEvent.summary);
    }
  });
  app.addHook("onClose", async () => unsubscribe());

  function detail(conversation: Conversation): ConversationDetail {
    const messages = store.conversationMessages(conversation.id);
    const lastUser = [...messages].reverse().find((m) => m.author === "user");
    return {
      ...conversation,
      messages,
      runWorkId: lastWorkOf.get(conversation.id),
      model: lastUser?.model,
      effort: lastUser?.effort,
      contextTokens: store.getConversationContextTokens(conversation.id),
    };
  }

  function dispatch(conversation: Conversation, unsentBodies: string[], choice: { model?: string; effort?: CreateConversationMessageRequest["effort"] }): void {
    const page = store.getPage(conversation.pageId)!;
    const session = store.getConversationSession(conversation.id);
    const sessionId = session?.sessionId ?? randomUUID();
    const item: WorkItem = {
      id: randomUUID(),
      kind: "conversation",
      conversationId: conversation.id,
      pageId: page.id,
      threads: [],
      message: conversationMessage(page.title, page.id, unsentBodies),
      sessionId,
      resume: session !== undefined,
      ...choice,
    };
    conversationOfWork.set(item.id, conversation.id);
    lastWorkOf.set(conversation.id, item.id);
    lock.submit(
      {
        projectId: page.projectId,
        agentId: session?.agentId,
        onDispatched: (agentId) => store.setConversationSession(conversation.id, sessionId, agentId),
      },
      item,
    );
  }

  app.get<{ Params: { pageId: string } }>("/api/pages/:pageId/conversations", async (req, reply) => {
    if (!store.getPage(req.params.pageId)) return reply.code(404).send({ error: "page not found" });
    return store.listConversations(req.params.pageId);
  });

  app.post<{ Params: { pageId: string }; Body: CreateConversationRequest }>("/api/pages/:pageId/conversations", async (req, reply) => {
    const page = store.getPage(req.params.pageId);
    if (!page) return reply.code(404).send({ error: "page not found" });
    const title = req.body?.title;
    if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
      return reply.code(400).send({ error: "title must be a non-empty string" });
    }
    const first = !store.projectHasConversation(page.projectId);
    const conversation = store.createConversation(page.id, title ?? "Nouvelle conversation");
    const instructions = store.getProject(page.projectId)?.instructions ?? "";
    if (first && instructions.trim() !== "") store.addConversationMessage(conversation.id, "user", instructions);
    return reply.code(201).send(detail(conversation));
  });

  app.get<{ Params: { conversationId: string } }>("/api/conversations/:conversationId", async (req, reply) => {
    const conversation = store.getConversation(req.params.conversationId);
    return conversation ? detail(conversation) : reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{ Params: { conversationId: string } }>("/api/conversations/:conversationId/archive", async (req, reply) => {
    const conversation = store.archiveConversation(req.params.conversationId);
    return conversation ? detail(conversation) : reply.code(404).send({ error: "conversation not found" });
  });

  app.post<{ Params: { conversationId: string }; Body: CreateConversationMessageRequest }>(
    "/api/conversations/:conversationId/messages",
    async (req, reply) => {
      const conversation = store.getConversation(req.params.conversationId);
      if (!conversation) return reply.code(404).send({ error: "conversation not found" });
      if (conversation.archived) return reply.code(409).send({ error: "conversation is archived" });
      const { body, model, effort } = req.body ?? ({} as Partial<CreateConversationMessageRequest>);
      if (typeof body !== "string" || body.trim() === "") return reply.code(400).send({ error: "body is required" });
      if (model !== undefined && typeof model !== "string") return reply.code(400).send({ error: "model must be a string" });
      if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) return reply.code(400).send({ error: "invalid effort" });
      // Messages not yet sent to Claude (the project's instructions on the first send) go along with this one.
      const unsent = store.getConversationSession(conversation.id) ? [] : store.conversationMessages(conversation.id).map((m) => m.body);
      const message = store.addConversationMessage(conversation.id, "user", body, { model, effort })!;
      dispatch(conversation, [...unsent, body], { model, effort });
      return reply.code(201).send(message);
    },
  );
}
