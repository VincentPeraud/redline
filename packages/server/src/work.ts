import { randomUUID } from "node:crypto";
import type { ModelChoice, Thread, WorkItem, WorkThread } from "@redline/shared";
import { seededMessage } from "./context.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { definedChoice } from "./validation.js";

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

/** The message for a new session the global agent starts in place of the agent that opened the thread: the conversation so far, then the user's reply. */
export function takeoverMessage(thread: Thread, body: string): string {
  const history = thread.replies.map((r) => `${r.author === "user" ? "User" : "Claude"}: ${r.body}`);
  return [
    threadMessage(thread),
    "",
    "This comment was already discussed in an earlier session that is not available now. Conversation so far:",
    ...history.flatMap((line) => ["", line]),
    "",
    "New reply from the user:",
    "",
    body,
  ].join("\n");
}

/** Queues a work item for a freshly sent thread on its page's lock; the lock remembers the session once the item is sent. */
export function dispatchThread(lock: PageLock, projectId: string, thread: Thread, choice: ModelChoice = {}): void {
  lock.submit({ projectId }, { ...threadItem(thread, threadMessage(thread), randomUUID(), false), ...definedChoice(choice) });
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
export function dispatchBatch(lock: PageLock, projectId: string, threads: Thread[], choice: ModelChoice = {}): void {
  const item = { ...threadItem(threads[0], batchMessage(threads), randomUUID(), false), threads: threads.map(workThread), ...definedChoice(choice) };
  lock.submit({ projectId }, item);
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
  choice: ModelChoice = {},
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
  // A seeded item (new session from a summary) is not a resume, but still belongs to the session.
  if (lock.amendQueued((item) => item.sessionId === session.sessionId, join)) return;

  const seed = store.getSessionSeed(thread.id);
  const message = seed ? seededMessage(seed, reply) : reply;
  const item = { ...threadItem(thread, message, session.sessionId, !seed), ...definedChoice(choice) };
  const takeoverItem = { ...threadItem(thread, takeoverMessage(thread, body), randomUUID(), false), ...definedChoice(choice) };
  lock.submit({ projectId, agentId: session.agentId, takeoverItem }, item);
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
