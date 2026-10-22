import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EFFORTS,
  type Conversation,
  type ConversationDetail,
  type ConversationMessage,
  type CreateConversationMessageRequest,
  type CreateConversationRequest,
  type ServerEvent,
  type WorkItem,
} from "@redline/shared";
import { contextOf, usageContext } from "./context.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

export type SendConversationMessage = (
  conversation: Conversation,
  body: string,
  choice: { model?: string; effort?: CreateConversationMessageRequest["effort"] },
  options?: { extraContext?: string; projectId?: string },
) => ConversationMessage;

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
 * `lastWorkOf` maps each conversation to the work id of its latest message.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  store: Store,
  lock: PageLock,
  knownWindows: Map<string, number>,
): { sendMessage: SendConversationMessage; lastWorkOf: Map<string, string> } {
  const conversationOfWork = new Map<string, string>();
  const lastWorkOf = new Map<string, string>();
  const modelOfWork = new Map<string, string>();

  const unsubscribe = store.onChange((event: ServerEvent) => {
    if (event.type !== "work" || event.message.type !== "work-event") return;
    const conversationId = conversationOfWork.get(event.message.workId);
    if (!conversationId) return;
    const engineEvent = event.message.event;
    if (engineEvent.type === "usage") {
      modelOfWork.set(event.message.workId, engineEvent.model);
      store.setConversationContext(conversationId, usageContext(engineEvent, knownWindows, store.getConversationContext(conversationId)));
    } else if (engineEvent.type === "result") {
      const model = modelOfWork.get(event.message.workId);
      const current = store.getConversationContext(conversationId);
      if (model && engineEvent.contextWindow) {
        knownWindows.set(model, engineEvent.contextWindow);
        if (current?.model === model) store.setConversationContext(conversationId, contextOf(model, current.tokens, engineEvent.contextWindow, current.effort));
      }
      if (engineEvent.summary.trim() !== "") store.addConversationMessage(conversationId, "claude", engineEvent.summary);
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
      context: store.getConversationContext(conversation.id),
    };
  }

  function dispatch(
    conversation: Conversation,
    unsentBodies: string[],
    choice: { model?: string; effort?: CreateConversationMessageRequest["effort"] },
    projectId: string,
  ): void {
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
        projectId,
        agentId: session?.agentId,
        onDispatched: (agentId) => store.setConversationSession(conversation.id, sessionId, agentId),
      },
      item,
    );
  }

  /** Stores a user message and dispatches it; `extraContext` goes to Claude with it without being stored, and `projectId` overrides the project whose agent serves it. */
  const sendMessage: SendConversationMessage = (conversation, body, choice, options = {}) => {
    // Messages not yet sent to Claude (the project's instructions on the first send) go along with this one.
    const unsent = store.getConversationSession(conversation.id) ? [] : store.conversationMessages(conversation.id).map((m) => m.body);
    const message = store.addConversationMessage(conversation.id, "user", body, choice)!;
    const bodies = [...(options.extraContext ? [options.extraContext] : []), ...unsent, body];
    dispatch(conversation, bodies, choice, options.projectId ?? store.getPage(conversation.pageId)!.projectId);
    return message;
  };

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
      const message = sendMessage(conversation, body, { model, effort });
      return reply.code(201).send(message);
    },
  );

  return { sendMessage, lastWorkOf };
}
