import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  type Conversation,
  type ConversationDetail,
  type ConversationMessage,
  type CreateConversationMessageRequest,
  type CreateConversationRequest,
  type MessageContext,
  type ModelChoice,
  type Person,
  type ThreadTarget,
  type ServerEvent,
  type WorkItem,
} from "@redline/shared";
import { renderingLabel } from "@redline/shared";
import { canvasElementText } from "./canvas-element-text.js";
import { cellSeenText, elementText, renderingText } from "./thread-subject.js";
import { contextOf, usageContext } from "./context.js";
import { definedChoice, isMessageContext, modelChoiceError, modelChoiceOf, requiredString } from "./validation.js";
import { viewerOf } from "./identity.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

export type SendConversationMessage = (
  conversation: Conversation,
  body: string,
  choice: ModelChoice,
  options?: { context?: MessageContext; extraContext?: string; projectId?: string; brief?: boolean; person?: Person },
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

function chipLine(target: ThreadTarget, number: number): string {
  switch (target.kind) {
    case "element":
      return `${number}: ${elementText(target)} on artboard ${target.artboard}${renderingText(target.rendering)}${cellSeenText(target.cell)}`;
    case "artboard":
      return `${number}: the whole artboard ${target.artboard}`;
    case "canvas-element":
      return `${number}: ${canvasElementText(target)}`;
  }
}

/** The lines that follow a conversation message: what the user is looking at, the tweak values and the numbered chips. */
export function contextBlock(context: MessageContext): string {
  const files = context.visibleArtboards.map(({ file, rendering }) => (rendering ? `${file} (${renderingLabel(rendering)})` : file));
  return [
    `The user is looking at: ${files.length > 0 ? files.join(", ") : "no artboard on screen"}`,
    ...(context.tweaks.length > 0 ? [`Tweak values: ${context.tweaks.map((t) => `${t.label}: ${t.value}`).join(", ")}`] : []),
    ...(context.targets && context.targets.length > 0 ? ["Elements the user points at:", ...context.targets.map((t, i) => chipLine(t, i + 1))] : []),
  ].join("\n");
}

/** The first message of a project's first conversation: its brief, to read and keep in mind (cheap: no edit, one line back). */
export function briefMessage(pageTitle: string, pageId: string, instructions: string): string {
  return [
    `Conversation about the page "${pageTitle}" (page id ${pageId}). Before the user writes, here is the project's brief. Read it and keep it in mind for this whole conversation.`,
    "Do not edit any file and do not call any tool: answer with one short sentence saying you have the brief.",
    "",
    instructions,
  ].join("\n");
}

/** What a new session is told when it takes over a conversation whose own session is not available. */
export function conversationHistory(previous: ConversationMessage[]): string {
  const lines = previous.map((m) => `${m.author === "user" ? "User" : "Claude"}: ${m.body}`);
  return ["This conversation was already going in an earlier session that is not available now. Conversation so far:", "", ...lines].join("\n");
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
  const lastWorkOf = new Map<string, string>();
  const modelOfWork = new Map<string, string>();

  const unsubscribe = store.onChange((event: ServerEvent) => {
    if (event.type !== "work" || event.message.type !== "work-event") return;
    const conversationId = lock.itemOf(event.message.workId)?.conversationId;
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
      // Pages the run created with create_page are shown under its answer.
      const createdPageIds = store.takeCreatedPages(event.message.workId);
      if (engineEvent.summary.trim() !== "") store.addConversationMessage(conversationId, "claude", engineEvent.summary, {}, createdPageIds);
    }
  });
  app.addHook("onClose", async () => unsubscribe());

  /**
   * Flags Claude's answers whose run published a version of a design system page. The answer is stored before the run
   * publishes, so a run is matched to the span from its user message to the next one, not to the answer's own time.
   */
  function withDesignSystemChanges(conversation: Conversation, messages: ConversationMessage[]): ConversationMessage[] {
    const designSystem = store.designSystemOfPage(conversation.pageId);
    if (!designSystem) return messages;
    const versions = store.listVersions(conversation.pageId).filter((v) => v.origin === "conversation" && v.originId === conversation.id);
    return messages.map((message, index) => {
      if (message.author !== "claude") return message;
      const start = messages.slice(0, index).reverse().find((m) => m.author === "user")?.createdAt ?? "";
      const end = messages.slice(index + 1).find((m) => m.author === "user")?.createdAt;
      const published = versions.some((v) => v.createdAt >= start && (end === undefined || v.createdAt < end));
      return published ? { ...message, designSystemId: designSystem.id } : message;
    });
  }

  function detail(conversation: Conversation): ConversationDetail {
    const messages = withDesignSystemChanges(conversation, store.conversationMessages(conversation.id));
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
    previous: ConversationMessage[],
    bodies: string[],
    choice: ModelChoice,
    projectId: string,
    firstMessage?: string,
  ): void {
    // A message sent while an earlier one of the conversation has not left yet (queued, or waiting for a retry) joins it.
    const joined = lock.amendQueued(
      (item) => item.conversationId === conversation.id,
      (item) => ({
        ...item,
        message: `${item.message}\n\nFollow-up from the user, sent before the message above was answered:\n\n${bodies.join("\n\n")}`,
        ...definedChoice(choice),
      }),
    );
    if (joined) return;
    const page = store.getPage(conversation.pageId)!;
    const session = store.getConversationSession(conversation.id);
    // Messages never sent to Claude (everything stored, when there is no session yet) go along with this one.
    const sent = session ? bodies : [...previous.map((m) => m.body), ...bodies];
    const item: WorkItem = {
      id: randomUUID(),
      kind: "conversation",
      conversationId: conversation.id,
      pageId: page.id,
      threads: [],
      message: firstMessage ?? conversationMessage(page.title, page.id, sent),
      sessionId: session?.sessionId ?? randomUUID(),
      resume: session !== undefined,
      ...definedChoice(choice),
    };
    lastWorkOf.set(conversation.id, item.id);
    const takeoverItem: WorkItem | undefined = session && {
      ...item,
      id: randomUUID(),
      sessionId: randomUUID(),
      resume: false,
      message: conversationMessage(page.title, page.id, [conversationHistory(previous), ...bodies]),
    };
    lock.submit({ projectId, agentId: session?.agentId, takeoverItem }, item);
  }

  /** Stores a user message and dispatches it; `extraContext` goes to Claude with it without being stored, and `projectId` overrides the project whose agent serves it. */
  const sendMessage: SendConversationMessage = (conversation, body, choice, options = {}) => {
    const previous = store.conversationMessages(conversation.id);
    const message = store.addConversationMessage(conversation.id, "user", body, choice, [], options.context?.targets, options.person)!;
    const page = store.getPage(conversation.pageId)!;
    dispatch(
      conversation,
      previous,
      [...(options.extraContext ? [options.extraContext] : []), options.context ? `${body}\n\n${contextBlock(options.context)}` : body],
      choice,
      options.projectId ?? page.projectId,
      options.brief ? briefMessage(page.title, page.id, body) : undefined,
    );
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
    if (title !== undefined && !requiredString(title)) {
      return reply.code(400).send({ error: "title must be a non-empty string" });
    }
    const first = !store.projectHasConversation(page.projectId);
    const conversation = store.createConversation(page.id, title ?? "Nouvelle conversation", viewerOf(req));
    const instructions = store.getProject(page.projectId)?.instructions ?? "";
    // The project's brief opens its first conversation: it is sent now, with a short acknowledgement asked back.
    if (first && instructions.trim() !== "") sendMessage(conversation, instructions, {}, { brief: true, person: viewerOf(req) });
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
      const { body } = req.body ?? ({} as Partial<CreateConversationMessageRequest>);
      if (!requiredString(body)) return reply.code(400).send({ error: "body is required" });
      const invalidChoice = modelChoiceError(req.body);
      if (invalidChoice) return reply.code(400).send({ error: invalidChoice });
      if (req.body.context !== undefined && !isMessageContext(req.body.context)) return reply.code(400).send({ error: "context is malformed" });
      const message = sendMessage(conversation, body, modelChoiceOf(req.body), { context: req.body.context, person: viewerOf(req) });
      return reply.code(201).send(message);
    },
  );

  return { sendMessage, lastWorkOf };
}
