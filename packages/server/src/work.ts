import { randomUUID } from "node:crypto";
import { type ModelChoice, type Person, Thread, WorkItem, WorkThread } from "@redline/shared";
import { seededMessage } from "./context.js";
import { replyLine, threadSubject } from "./thread-subject.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { canvasElementTail } from "./canvas-element-text.js";
import { definedChoice } from "./validation.js";
import { goingToAgent, routeOf } from "./routing.js";

/** A request to the design system says where it comes from and what to do with it, before the comment itself. */
function requestPreface(thread: Thread): string[] {
  const origin = thread.request?.origins[0];
  if (!thread.request || !origin) return [];
  const lines = [
    `This is a request from the project ${origin.projectTitle} (page ${origin.pageTitle}, artboard ${origin.artboard}${origin.selector ? `, instance \`${origin.selector}\`` : ""}) for the component ui-${thread.request.component}.`,
    "Make the change in the design system's draft (the component's artboard); the user reviews it before diffusing it. No one has to accept the request first.",
    "",
  ];
  return lines;
}

/** The message Claude receives for one thread: the comment with its thread id, artboard, element and position. */
export function threadMessage(thread: Thread): string {
  return [
    ...requestPreface(thread),
    `Comment ${thread.number} (thread id: ${thread.id}) ${threadSubject(thread)}:`,
    "",
    thread.body,
    ...(thread.request?.detail ? ["", `What the project's session needs: ${thread.request.detail}`] : []),
    "",
    thread.target.kind === "canvas-element"
      ? `${canvasElementTail(thread.target)} Then answer in the thread with the reply_in_thread tool (threadId ${thread.id}).`
      : `Make the change in the working copy if the comment asks for one, then answer in the thread with the reply_in_thread tool (threadId ${thread.id}).`,
  ].join("\n");
}

/** The message Claude receives for a user's reply in a thread whose session it resumes. */
export function replyMessage(thread: Thread, body: string, sender = "the user"): string {
  return [
    `Reply from ${sender} in comment ${thread.number} (thread id: ${thread.id}):`,
    "",
    body,
    "",
    `Make the change in the working copy if the reply asks for one, then answer in the thread with the reply_in_thread tool (threadId ${thread.id}).`,
  ].join("\n");
}

/** The message for a new session the global agent starts in place of the agent that opened the thread: the conversation so far, then the user's reply. */
export function takeoverMessage(thread: Thread, body: string): string {
  const history = thread.replies.map(replyLine);
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

/**
 * Queues a work item for a freshly sent thread on its page's lock, when the routing rule sends it to the agent (see `routeOf`);
 * a thread to take, or taken by an account, has no work: a conversation takes it on request.
 */
export function dispatchThread(store: Store, lock: PageLock, projectId: string, thread: Thread, choice: ModelChoice = {}): void {
  if (routeOf(store, lock, thread) !== "agent") return;
  lock.submit({ projectId }, { ...threadItem(thread, threadMessage(thread), randomUUID(), false), ...definedChoice(choice) });
}

/** The message of a thread an agent takes over with no session to resume: the comment, then the conversation so far, if any. */
export function freshSessionMessage(thread: Thread): string {
  if (thread.replies.length === 0) return threadMessage(thread);
  const history = thread.replies.map(replyLine);
  return [
    threadMessage(thread),
    "",
    "This comment was already discussed in an earlier session that is not available now. Conversation so far:",
    ...history.flatMap((line) => ["", line]),
  ].join("\n");
}

/** The message Claude receives for a batch: every held comment of a page with its thread id, artboard, element and position. */
export function batchMessage(threads: Thread[]): string {
  return [
    `${threads.length} comments on this page, sent together. Handle each one, then answer in each thread separately with the reply_in_thread tool (use the thread id of that comment).`,
    "",
    ...threads.flatMap((thread) => [
      `Comment ${thread.number} (thread id: ${thread.id}) ${threadSubject(thread)}:`,
      "",
      thread.body,
      "",
      ...(thread.replies.length > 0 ? ["Discussion so far:", ...thread.replies.flatMap((r) => ["", replyLine(r)]), ""] : []),
      ...(thread.target.kind === "canvas-element" ? [canvasElementTail(thread.target), ""] : []),
    ]),
  ].join("\n");
}

/**
 * Sends "À relire" threads to the agents. A thread Claude already answered resumes its session with the replies written since;
 * the others leave together as one message (a single one as a plain thread message), with the discussion so far if there is any.
 */
export function dispatchReviewed(store: Store, lock: PageLock, projectId: string, allThreads: Thread[], choice: ModelChoice = {}): void {
  const threads = goingToAgent(store, lock, allThreads);
  const answered = (thread: Thread) => thread.replies.some((r) => r.author === "claude");
  for (const thread of threads.filter(answered)) {
    const lastAnswer = thread.replies.map((r) => r.author).lastIndexOf("claude");
    const since = thread.replies.slice(lastAnswer + 1).filter((r) => r.author === "user").map((r) => r.body);
    queueReply(store, lock, projectId, thread, since.join("\n\n") || thread.body, choice);
  }
  const fresh = threads.filter((thread) => !answered(thread));
  if (fresh.length > 0) submitTogether(lock, projectId, fresh, fresh.length === 1 ? freshSessionMessage(fresh[0]) : batchMessage(fresh), choice);
}

/**
 * Queues the held comments of one page as a single work item (one message, one new session shared by the threads),
 * for those the routing rule sends to the agent.
 */
export function dispatchBatch(store: Store, lock: PageLock, projectId: string, allThreads: Thread[], choice: ModelChoice = {}): void {
  const threads = goingToAgent(store, lock, allThreads);
  if (threads.length > 0) submitTogether(lock, projectId, threads, batchMessage(threads), choice);
}

/** One new session, one message, for threads the routing rule already sent to the agent. */
function submitTogether(lock: PageLock, projectId: string, threads: Thread[], message: string, choice: ModelChoice): void {
  lock.submit({ projectId }, { ...threadItem(threads[0], message, randomUUID(), false), threads: threads.map(workThread), ...definedChoice(choice) });
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
  sender?: string,
): void {
  if (routeOf(store, lock, thread) === "agent") queueReply(store, lock, projectId, thread, body, choice, sender);
}

/** `dispatchReply` for a thread the routing rule already sent to the agent. */
function queueReply(store: Store, lock: PageLock, projectId: string, thread: Thread, body: string, choice: ModelChoice, sender?: string): void {
  const reply = replyMessage(thread, body, sender);
  const join = (item: WorkItem): WorkItem => ({
    ...item,
    threads: item.threads.some((t) => t.threadId === thread.id) ? item.threads : [...item.threads, workThread(thread)],
    message: `${item.message}\n\n${reply}`,
    ...definedChoice(choice),
  });

  // The thread's own message has not left yet (no session): the reply goes in the same message.
  if (lock.amendQueued((item) => item.threads.some((t) => t.threadId === thread.id), join)) return;

  const takeover = { ...threadItem(thread, takeoverMessage(thread, body), randomUUID(), false), ...definedChoice(choice) };

  const session = store.getThreadSession(thread.id);
  if (!session) {
    // A thread of a page in Agent mode no agent session answered (a conversation did, or it never ran): an agent starts afresh from the thread's history.
    // A message from Redline reaches a thread nobody answers now (the user's reply on an unanswered thread would only duplicate it).
    if (sender !== undefined || thread.replies.some((r) => r.author === "claude")) lock.submit({ projectId }, takeover);
    return;
  }
  // A seeded item (new session from a summary) is not a resume, but still belongs to the session.
  if (lock.amendQueued((item) => item.sessionId === session.sessionId, join)) return;

  const seed = store.getSessionSeed(thread.id);
  const message = seed ? seededMessage(seed, reply) : reply;
  const item = { ...threadItem(thread, message, session.sessionId, !seed), ...definedChoice(choice) };
  lock.submit({ projectId, agentId: session.agentId, takeoverItem: takeover }, item);
}

/**
 * "Confier à l'agent": queues the thread's work whatever the page's mode (the caller released the take), signed by `by`.
 * The agent starts afresh from the thread's history; the thread is then the agent's (`routeOf` sees the queued work, then its session).
 */
export function handOverThread(lock: PageLock, projectId: string, thread: Thread, by: Person | undefined, choice: ModelChoice = {}): void {
  lock.submit({ projectId, ...(by ? { handedOverBy: by } : {}) }, { ...threadItem(thread, freshSessionMessage(thread), randomUUID(), false), ...definedChoice(choice) });
}

function workThread(thread: Thread): WorkThread {
  return {
    threadId: thread.id,
    number: thread.number,
    artboard: thread.artboard,
    selector: thread.selector,
    ...(thread.elementName ? { elementName: thread.elementName } : {}),
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
