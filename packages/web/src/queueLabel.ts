import type { QueueEntry, QueueReason } from "@redline/shared";

const REASON_LABEL: Record<Exclude<QueueReason, "terminal">, string> = {
  "page-busy": "page occupée par une autre session",
  "agent-offline": "agent hors ligne",
  "project-archived": "projet archivé",
  "page-archived": "page archivée",
};

const WAITING_FOR_TERMINAL = "En attente de la session terminal";

function labelOf(entry: QueueEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.reason === "terminal" ? WAITING_FOR_TERMINAL : `En file · ${REASON_LABEL[entry.reason]}`;
}

/** "En file · <reason>" for a thread waiting in the page's queue, undefined when it is not waiting. */
export function queueLabel(queue: QueueEntry[], threadId: string): string | undefined {
  return labelOf(queue.find((e) => e.threadIds.includes(threadId)));
}

/** Same label for a work item that answers no thread (a conversation message), found by its work id. */
export function workQueueLabel(queue: QueueEntry[], workId: string | undefined): string | undefined {
  return labelOf(queue.find((e) => e.workId === workId));
}
