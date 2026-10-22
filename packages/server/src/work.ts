import { randomUUID } from "node:crypto";
import type { Effort, Thread, WorkItem, WorkThread } from "@redline/shared";
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

/** The message Claude receives for a batch: every held comment of a page with its thread id, artboard, element and position. */
export function batchMessage(threads: Thread[]): string {
  return [
    `${threads.length} comments on this page, sent together. Handle each one, then answer in each thread separately with the reply_in_thread tool (use the thread id of that comment).`,
    "",
    ...threads.flatMap((thread) => [
      `Comment ${thread.number} (thread id: ${thread.id}) on artboard ${thread.artboard}, element \`${thread.selector}\` (position ${thread.xPct}% / ${thread.yPct}% of the artboard):`,
      "",
      thread.body,
      "",
    ]),
  ].join("\n");
}

/** Queues the held comments of one page as a single work item (one message, one new session shared by the threads). */
export function dispatchBatch(
  store: Store,
  lock: PageLock,
  projectId: string,
  threads: Thread[],
  choice: { model?: string; effort?: Effort } = {},
): void {
  const sessionId = randomUUID();
  const item = { ...threadItem(threads[0], batchMessage(threads), sessionId, false), threads: threads.map(workThread), ...choice };
  lock.submit(
    {
      projectId,
      onDispatched: (agentId) => {
        for (const thread of threads) store.setThreadSession(thread.id, sessionId, agentId);
      },
    },
    item,
  );
}

/**
 * Sends the user's reply in a thread. Replies leave together: if the thread (or another thread of its session) is
 * still queued, the reply joins that pending message; otherwise it resumes the thread's session on the agent that opened it.
 * `choice` is the model and effort picked for this message; what is absent falls back to the agent's default.
 */
export function dispatchReply(
  store: Store,
  lock: PageLock,
  projectId: string,
  thread: Thread,
  body: string,
  choice: { model?: string; effort?: Effort } = {},
): void {
  const reply = replyMessage(thread, body);
  const join = (item: WorkItem): WorkItem => ({
    ...item,
    threads: item.threads.some((t) => t.threadId === thread.id) ? item.threads : [...item.threads, workThread(thread)],
    message: `${item.message}\n\n${reply}`,
    ...definedChoice(choice),
  });

  // The thread's own message has not left yet (no session): the reply goes in the same message.
  if (lock.amendQueued((item) => item.threads.some((t) => t.threadId === thread.id), join)) return;

  const session = store.getThreadSession(thread.id);
  if (!session) return;
  if (lock.amendQueued((item) => item.resume && item.sessionId === session.sessionId, join)) return;
  const item = { ...threadItem(thread, reply, session.sessionId, true), ...choice };
  lock.submit({ projectId, agentId: session.agentId }, item);
}

function definedChoice(choice: { model?: string; effort?: Effort }): { model?: string; effort?: Effort } {
  return {
    ...(choice.model !== undefined && { model: choice.model }),
    ...(choice.effort !== undefined && { effort: choice.effort }),
  };
}

function workThread(thread: Thread): WorkThread {
  return {
    threadId: thread.id,
    number: thread.number,
    artboard: thread.artboard,
    selector: thread.selector,
    xPct: thread.xPct,
    yPct: thread.yPct,
    body: thread.body,
  };
}

function threadItem(thread: Thread, message: string, sessionId: string, resume: boolean): WorkItem {
  return {
    id: randomUUID(),
    kind: "thread",
    pageId: thread.pageId,
    threads: [workThread(thread)],
    message,
    sessionId,
    resume,
  };
}
