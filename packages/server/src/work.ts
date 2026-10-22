import { randomUUID } from "node:crypto";
import type { Effort, Thread, WorkItem } from "@redline/shared";
import { seededMessage } from "./context.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

/** The message Claude receives for one thread: the comment with its thread id, artboard, element and position. */
export function threadMessage(thread: Thread): string {
  return [
    `Comment ${thread.number} (thread id: ${thread.id}) on artboard ${thread.artboard}, element \`${thread.selector}\` (position ${thread.xPct}% / ${thread.yPct}% of the artboard):`,
    "",
    thread.body,
    "",
    `Make the change in the working copy if the comment asks for one, then answer in the thread with the reply_in_thread tool (threadId ${thread.id}).`,
  ].join("\n");
}

/** The message Claude receives for a user's reply in a thread whose session it resumes. */
export function replyMessage(thread: Thread, body: string): string {
  return [
    `Reply from the user in comment ${thread.number} (thread id: ${thread.id}):`,
    "",
    body,
    "",
    `Make the change in the working copy if the reply asks for one, then answer in the thread with the reply_in_thread tool (threadId ${thread.id}).`,
  ].join("\n");
}

/** Queues a work item for a freshly sent thread on its page's lock; the session is remembered once the item is sent. */
export function dispatchThread(store: Store, lock: PageLock, projectId: string, thread: Thread): void {
  const sessionId = randomUUID();
  lock.submit(
    { projectId, onDispatched: (agentId) => store.setThreadSession(thread.id, sessionId, agentId) },
    threadItem(thread, threadMessage(thread), sessionId, false),
  );
}

/**
 * Queues the resumption of the thread's session, on the agent that opened it, with the user's reply. False when the thread has no session yet.
 * `choice` is the model and effort picked for this message; what is absent falls back to the agent's default.
 */
export function dispatchReply(
  store: Store,
  lock: PageLock,
  projectId: string,
  thread: Thread,
  body: string,
  choice: { model?: string; effort?: Effort } = {},
): boolean {
  const session = store.getThreadSession(thread.id);
  if (!session) return false;
  const seed = store.getSessionSeed(thread.id);
  const message = seed ? seededMessage(seed, replyMessage(thread, body)) : replyMessage(thread, body);
  const item = { ...threadItem(thread, message, session.sessionId, !seed), ...choice };
  lock.submit({ projectId, agentId: session.agentId, onDispatched: seed ? () => store.setNewSession(thread.id, null) : undefined }, item);
  return true;
}

function threadItem(thread: Thread, message: string, sessionId: string, resume: boolean): WorkItem {
  return {
    id: randomUUID(),
    kind: "thread",
    pageId: thread.pageId,
    threads: [
      {
        threadId: thread.id,
        number: thread.number,
        artboard: thread.artboard,
        selector: thread.selector,
        xPct: thread.xPct,
        yPct: thread.yPct,
        body: thread.body,
      },
    ],
    message,
    sessionId,
    resume,
  };
}
