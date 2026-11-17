import type { QueueEntry, QueueReason } from "@redline/shared";

const REASON_LABEL: Record<QueueReason, string> = {
  "page-busy": "page occupée par une autre session",
  "agent-offline": "agent hors ligne",
  "project-archived": "projet archivé",
  "page-archived": "page archivée",
};

function labelOf(entry: QueueEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return `En file · ${REASON_LABEL[entry.reason]}`;
}

/** "En file · <reason>" for a thread waiting in the page's queue, undefined when it is not waiting. */
export function queueLabel(queue: QueueEntry[], threadId: string): string | undefined {
  return labelOf(queue.find((e) => e.threadIds.includes(threadId)));
}

/** The thread waits in the queue for an agent that is offline (a thread sent in Agent mode while no agent runs). */
export function waitingForOfflineAgent(queue: QueueEntry[], threadId: string): boolean {
  return queue.some((entry) => entry.reason === "agent-offline" && entry.threadIds.includes(threadId));
}

/** Same label for a work item that answers no thread (a conversation message), found by its work id. */
export function workQueueLabel(queue: QueueEntry[], workId: string | undefined): string | undefined {
  return labelOf(queue.find((e) => e.workId === workId));
}
