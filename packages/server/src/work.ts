import { randomUUID } from "node:crypto";
import type { Thread, WorkItem } from "@redline/shared";
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

/** Pushes a work item for a freshly sent thread to the project's agent. Returns false when no agent is online. */
export function dispatchThread(store: Store, hub: AgentHub, projectId: string, thread: Thread): boolean {
  const agentId = store.findOnlineProjectAgentId(projectId);
  if (!agentId) return false;
  const item: WorkItem = {
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
    message: threadMessage(thread),
    sessionId: randomUUID(),
    resume: false,
  };
  const sent = hub.send(agentId, { type: "work", item });
  if (sent) store.emit({ type: "work-dispatched", pageId: item.pageId, workId: item.id, threadIds: [thread.id] });
  return sent;
}
