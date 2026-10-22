import { randomUUID } from "node:crypto";
import type { Effort, Thread, WorkItem } from "@redline/shared";
import type { AgentHub } from "./agents.js";
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

/** Pushes a work item for a freshly sent thread to the project's agent. Returns false when no agent is online. */
export function dispatchThread(store: Store, hub: AgentHub, projectId: string, thread: Thread): boolean {
  const agentId = store.findOnlineProjectAgentId(projectId);
  if (!agentId) return false;
  const sessionId = randomUUID();
  const sent = sendItem(store, hub, agentId, threadItem(thread, threadMessage(thread), sessionId, false));
  if (sent) store.setThreadSession(thread.id, sessionId, agentId);
  return sent;
}

/**
 * Resumes the thread's session, on the agent that opened it, with the user's reply. False when the thread has no session or its agent is offline.
 * `choice` is the model and effort picked for this message; what is absent falls back to the agent's default.
 */
export function dispatchReply(store: Store, hub: AgentHub, thread: Thread, body: string, choice: { model?: string; effort?: Effort } = {}): boolean {
  const session = store.getThreadSession(thread.id);
  if (!session) return false;
  const item = { ...threadItem(thread, replyMessage(thread, body), session.sessionId, true), ...choice };
  return sendItem(store, hub, session.agentId, item);
}

/** Sends a work item and, once sent, announces it so its run is tracked. */
function sendItem(store: Store, hub: AgentHub, agentId: string, item: WorkItem): boolean {
  const sent = hub.send(agentId, { type: "work", item });
  if (sent) {
    store.emit({ type: "work-dispatched", pageId: item.pageId, workId: item.id, threadIds: item.threads.map((t) => t.threadId) });
  }
  return sent;
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
