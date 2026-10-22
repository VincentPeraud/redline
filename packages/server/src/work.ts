import { randomUUID } from "node:crypto";
import type { Thread, WorkItem } from "@redline/shared";
import type { PageLock } from "./page-lock.js";

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

/** Queues a work item for a freshly sent thread on its page's lock. */
export function dispatchThread(lock: PageLock, projectId: string, thread: Thread): void {
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
  lock.submit(projectId, item);
}
