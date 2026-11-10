import { randomUUID } from "node:crypto";
import { type ModelChoice, type Person, Thread, WorkItem, WorkThread } from "@redline/shared";
import { seededMessage } from "./context.js";
import { replyLine, threadSubject } from "./thread-subject.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { canvasElementTail } from "./canvas-element-text.js";
import { definedChoice } from "./validation.js";

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

/** What the routing step asks about terminal sessions: new work waits for the present session holding its page, a reply for the present session of its thread. */
export interface TerminalPresence {
  holdsPage(pageId: string): boolean;
  isPresent(terminalSessionId: string): boolean;
}

/**
 * Queues a work item for a freshly sent thread on its page's lock; the lock remembers the session once the item is sent.
 * It waits for the terminal session instead of an agent when a present one holds the page.
 */
export function dispatchThread(lock: PageLock, projectId: string, thread: Thread, choice: ModelChoice = {}, terminal?: TerminalPresence): void {
  const forTerminal = terminal?.holdsPage(thread.pageId) ?? false;
  lock.submit({ projectId, ...(forTerminal ? { forTerminal } : {}) }, { ...threadItem(thread, threadMessage(thread), randomUUID(), false), ...definedChoice(choice) });
}

/** The message of a thread an agent takes over with no session to resume (a terminal session left): the comment, then the conversation so far, if any. */
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

/** Sends a thread to the agents in a fresh session (the terminal session that had it is gone). */
export function dispatchToAgent(lock: PageLock, projectId: string, thread: Thread): void {
  lock.submit({ projectId }, threadItem(thread, freshSessionMessage(thread), randomUUID(), false));
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
export function dispatchReviewed(store: Store, lock: PageLock, projectId: string, threads: Thread[], choice: ModelChoice = {}, terminal?: TerminalPresence): void {
  const answered = (thread: Thread) => thread.replies.some((r) => r.author === "claude");
  for (const thread of threads.filter(answered)) {
    const lastAnswer = thread.replies.map((r) => r.author).lastIndexOf("claude");
    const since = thread.replies.slice(lastAnswer + 1).filter((r) => r.author === "user").map((r) => r.body);
    dispatchReply(store, lock, projectId, thread, since.join("\n\n") || thread.body, choice, terminal);
  }
  const fresh = threads.filter((thread) => !answered(thread));
  if (fresh.length === 1) {
    const forTerminal = terminal?.holdsPage(fresh[0].pageId) ?? false;
    lock.submit({ projectId, ...(forTerminal ? { forTerminal } : {}) }, { ...threadItem(fresh[0], freshSessionMessage(fresh[0]), randomUUID(), false), ...definedChoice(choice) });
  } else if (fresh.length > 1) dispatchBatch(lock, projectId, fresh, choice, terminal);
}

/**
 * Queues the held comments of one page as a single work item (one message, one new session shared by the threads).
 * It waits for the terminal session instead of an agent when a present one holds the page.
 */
export function dispatchBatch(lock: PageLock, projectId: string, threads: Thread[], choice: ModelChoice = {}, terminal?: TerminalPresence): void {
  const forTerminal = terminal?.holdsPage(threads[0].pageId) ?? false;
  const item = { ...threadItem(threads[0], batchMessage(threads), randomUUID(), false), threads: threads.map(workThread), ...definedChoice(choice) };
  lock.submit({ projectId, ...(forTerminal ? { forTerminal } : {}) }, item);
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
  terminal?: TerminalPresence,
  sender?: string,
): void {
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
  const terminalSession = store.getThreadTerminalSession(thread.id);
  if (terminalSession) {
    // A thread a terminal session started: it waits for that session while it is present, else an agent starts afresh from the thread's history.
    if (terminal?.isPresent(terminalSession)) lock.submit({ projectId, forTerminal: true, takeoverItem: takeover }, { ...threadItem(thread, reply, randomUUID(), false), ...definedChoice(choice) });
    else lock.submit({ projectId }, takeover);
    return;
  }

  const session = store.getThreadSession(thread.id);
  if (!session) {
    // Answered by a terminal session that let go of its page since: an agent starts afresh from the thread's history.
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

const userReplies = (threads: Thread[]): string[] => threads.flatMap((t) => t.replies.filter((r) => r.author === "user").map((r) => replyMessage(t, r.body)));

/**
 * Sends the waiting work of one thread to the agents under the single routing rule. A thread waiting in a batch leaves it:
 * it gets its own work item and the others keep waiting. False when the thread is not waiting for a terminal session.
 * The thread belongs to the agent from then on: its item is sent to an agent, which records the session, and replies resume it.
 * The user's replies written while it waited go with the message.
 */
export function handOverThread(store: Store, lock: PageLock, threadId: string, handedOverBy?: Person): boolean {
  const handed = lock.releaseTerminalThread(
    threadId,
    (item) => {
      const thread = store.getThread(threadId)!;
      const others = item.threads.filter((t) => t.threadId !== threadId).map((t) => store.getThread(t.threadId)!);
      return {
        handed: { ...item, id: randomUUID(), sessionId: randomUUID(), threads: [workThread(thread)], message: [threadMessage(thread), ...userReplies([thread])].join("\n\n") },
        rest: { ...item, threads: others.map(workThread), message: [batchMessage(others), ...userReplies(others)].join("\n\n") },
      };
    },
    handedOverBy,
  );
  if (handed) store.clearThreadTerminalSession(threadId);
  return handed;
}
