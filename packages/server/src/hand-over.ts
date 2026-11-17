import type { HandOverCommentsResponse, HandOverRefusal, Person, Thread } from "@redline/shared";
import { chooseAgent } from "./agent-selection.js";
import { otherTakeOf, takerOf, targetLabel } from "./comment-takes.js";
import type { PageLock } from "./page-lock.js";
import { routeOf } from "./routing.js";
import type { Store } from "./store.js";
import { dispatchReviewed, handOverThread } from "./work.js";

export const NO_AGENT_REASON = "Aucun agent ne tourne : lance-en un depuis la page Agents";

/**
 * "Confier à l'agent": the thread leaves its take (if any) and is queued for the agent, signed by `by`, with the trace "Pris par X, puis confié à l'agent par Y".
 * A thread taken by someone else needs `confirm`. Answers the refusal, or undefined once done.
 */
export function handOver(store: Store, lock: PageLock, thread: Thread, by: Person | undefined, confirm: boolean): HandOverRefusal | undefined {
  if (thread.status !== "open") return { error: "Seul un fil ouvert peut être confié à l'agent.", code: "not-open" };
  if (routeOf(store, lock, thread) === "agent") return { error: "Ce fil est déjà à l'agent.", code: "already-agent" };
  const projectId = store.getPage(thread.pageId)!.projectId;
  if (chooseAgent(store, projectId) === undefined) return { error: NO_AGENT_REASON, code: "no-agent" };
  const previous = takerOf(thread);
  if (previous !== undefined && previous !== (by?.id ?? "") && !confirm) return { error: "Une conversation vient de prendre ce fil.", code: "taken", take: thread.take };
  if (previous !== undefined) store.releaseThreadTake(thread.id);
  handOverThread(lock, projectId, thread, by);
  if (by) store.addTrace(thread.id, { kind: "handed-over", ...(previous ? { takerId: previous } : {}), byId: by.id });
  return undefined;
}

/** "Libérer": the account lets go of its take; the thread follows the page's mode again. False when the thread is not taken by `accountId`. */
export function release(store: Store, lock: PageLock, thread: Thread, accountId: string): boolean {
  if (thread.status !== "open" || takerOf(thread) !== accountId) return false;
  store.releaseThreadTake(thread.id);
  dispatchReviewed(store, lock, store.getPage(thread.pageId)!.projectId, [store.getThread(thread.id)!]);
  return true;
}

/**
 * "traite les commentaires" in the page's web chat: every thread of the page waiting to be taken goes to the agent, signed by the member who wrote the message
 * (never over a take: threads taken by an account are listed as left alone). Stops at the first "no agent".
 */
export function handOverPage(store: Store, lock: PageLock, pageId: string, by: Person | undefined): HandOverCommentsResponse {
  const page = store.getPage(pageId)!;
  const threads = store.listThreads(pageId).filter((t) => t.status === "open");
  const handedOver: HandOverCommentsResponse["handedOver"] = [];
  for (const thread of threads.filter((t) => t.toTake)) {
    const refusal = handOver(store, lock, thread, by, false);
    if (refusal?.code === "no-agent") return { handedOver, leftAlone: [], noAgent: refusal.error };
    if (!refusal) handedOver.push({ threadId: thread.id, number: thread.number, target: targetLabel(thread) });
  }
  const leftAlone = threads.filter((t) => t.take).map((t) => otherTakeOf(store, t, page.title));
  return { handedOver, leftAlone };
}
