import type { QueueEntry, QueueReason } from "@redline/shared";

const REASON_LABEL: Record<QueueReason, string> = {
  "page-busy": "page occupée par une autre session",
  "agent-offline": "agent hors ligne",
  "project-archived": "projet archivé",
  "page-archived": "page archivée",
};

/** "En file · <reason>" for a thread waiting in the page's queue, undefined when it is not waiting. */
export function queueLabel(queue: QueueEntry[], threadId: string): string | undefined {
  const entry = queue.find((e) => e.threadIds.includes(threadId));
  return entry && `En file · ${REASON_LABEL[entry.reason]}`;
}

/** Same label for a work item that answers no thread (a conversation message), found by its work id. */
export function workQueueLabel(queue: QueueEntry[], workId: string | undefined): string | undefined {
  const entry = queue.find((e) => e.workId === workId);
  return entry && `En file · ${REASON_LABEL[entry.reason]}`;
}
