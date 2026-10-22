import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DEFAULT_CONTEXT_WINDOW, newSessionPath, type EngineEvent, type Thread, type ThreadContext, type WorkItem } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

export const SUMMARY_REQUEST =
  "Write a summary of this session for a colleague who takes over in a fresh session: what the page looks like now, the decisions made and why, what the user asked for and what is still open. Do not edit any file and do not call any tool. Answer with the summary only.";

/** The first message of a session seeded with the summary of the previous one. */
export function seededMessage(summary: string, message: string): string {
  return `You continue the work of a previous session. Its summary:\n\n${summary}\n\n---\n\n${message}`;
}

export function contextOf(model: string, tokens: number, window: number, effort: ThreadContext["effort"]): ThreadContext {
  return { model, ...(effort ? { effort } : {}), tokens, window, percent: Math.round((tokens / window) * 100) };
}

/** Context after a usage event: the model's real window once a result reported it, else the previous one or the default. */
export function usageContext(
  event: Extract<EngineEvent, { type: "usage" }>,
  knownWindows: Map<string, number>,
  previous: ThreadContext | undefined,
): ThreadContext {
  const window = knownWindows.get(event.model) ?? (previous?.model === event.model ? previous.window : DEFAULT_CONTEXT_WINDOW);
  return contextOf(event.model, event.inputTokens + event.cacheTokens + event.outputTokens, window, event.effort ?? previous?.effort);
}

/**
 * Keeps each thread's context % from the usage events of its runs (live, then frozen once the run
 * ends) and drives "Nouvelle session": ask the old session for a summary, then seed the next one.
 */
export function registerContextTracking(app: FastifyInstance, store: Store, lock: PageLock, knownWindows: Map<string, number>): void {
  const threadsOfWork = new Map<string, string[]>();
  const summaryOfWork = new Map<string, string>();
  const modelOfWork = new Map<string, string>();

  const unsubscribe = store.onChange((event) => {
    if (event.type === "work-dispatched") {
      threadsOfWork.set(event.workId, event.threadIds);
      return;
    }
    if (event.type !== "work") return;
    const message = event.message;
    const threadIds = threadsOfWork.get(message.workId) ?? [];
    if (message.type === "work-event") {
      const engineEvent = message.event;
      if (engineEvent.type === "usage") {
        modelOfWork.set(message.workId, engineEvent.model);
        for (const id of threadIds) store.setThreadContext(id, usageContext(engineEvent, knownWindows, store.getThread(id)?.context));
      } else if (engineEvent.type === "result") {
        const model = modelOfWork.get(message.workId);
        if (model && engineEvent.contextWindow) {
          knownWindows.set(model, engineEvent.contextWindow);
          for (const id of threadIds) {
            const current = store.getThread(id)?.context;
            if (current?.model === model) store.setThreadContext(id, contextOf(model, current.tokens, engineEvent.contextWindow, current.effort));
          }
        }
        const summarized = summaryOfWork.get(message.workId);
        if (summarized) startSeededSession(summarized, engineEvent.summary.trim());
      }
    } else {
      const summarized = summaryOfWork.get(message.workId);
      if (summarized && message.type === "work-failed" && store.getThread(summarized)?.newSession === "summarizing") store.setNewSession(summarized, null);
      if (message.type === "work-done" || message.type === "work-failed") {
        threadsOfWork.delete(message.workId);
        summaryOfWork.delete(message.workId);
        modelOfWork.delete(message.workId);
      }
    }
  });
  app.addHook("onClose", async () => unsubscribe());

  function startSeededSession(threadId: string, summary: string): void {
    const session = store.getThreadSession(threadId);
    if (!session || summary === "") return store.setNewSession(threadId, null);
    store.setThreadSession(threadId, randomUUID(), session.agentId);
    store.setThreadContext(threadId, null);
    store.setNewSession(threadId, "ready", summary);
  }

  app.post<{ Params: { threadId: string } }>(newSessionPath(":threadId"), async (req, reply) => {
    const thread = store.getThread(req.params.threadId);
    if (!thread) return reply.code(404).send({ error: "thread not found" });
    const session = store.getThreadSession(thread.id);
    if (!session) return reply.code(409).send({ error: "thread has no session yet" });
    if (thread.newSession === "summarizing") return reply.code(409).send({ error: "a summary is already being written" });
    requestSummary(thread, session);
    return reply.code(202).send({ ok: true });
  });

  function requestSummary(thread: Thread, session: { sessionId: string; agentId: string }): void {
    const item: WorkItem = {
      id: randomUUID(),
      kind: "summary",
      pageId: thread.pageId,
      threads: [],
      message: SUMMARY_REQUEST,
      sessionId: session.sessionId,
      resume: true,
    };
    summaryOfWork.set(item.id, thread.id);
    store.setNewSession(thread.id, "summarizing");
    lock.submit({ projectId: store.getPage(thread.pageId)!.projectId, agentId: session.agentId }, item);
  }
}
