import type { HandOverCommentsResponse, HandOverRefusal, Person, Thread } from "@redline/shared";
import { accountLevelIn } from "./access.js";
import { chooseAgent } from "./agent-selection.js";
import { isTakenBy, otherTakeOf, releaseTake, takerOf, targetLabel } from "./comment-takes.js";
import type { PageLock } from "./page-lock.js";
import { routeOf } from "./routing.js";
import type { Store } from "./store.js";
import { handOverThread } from "./work.js";

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
  if (thread.status !== "open" || !isTakenBy(thread, accountId)) return false;
  releaseTake(store, lock, thread);
  return true;
}

/**
 * The account loses access (deactivated, or lowered below Écriture on `projectId`): its open takes are freed with the trace
 * "libéré : <person> n'a plus accès" and follow their page's mode again. A page archived meanwhile keeps the agent work waiting
 * until it is unarchived.
 */
export function freeTakesOf(store: Store, lock: PageLock, accountId: string, projectId?: string): void {
  for (const id of store.openThreadsTakenBy(accountId, projectId)) {
    releaseTake(store, lock, store.getThread(id)!);
    store.addTrace(id, { kind: "released", takerId: accountId });
  }
}

/**
 * The takes of accounts that no longer have Écriture on their thread's project (a level lowered or removed, a project turned Private,
 * an admin lowered to member) are freed like a deactivation's, in `projectId` or everywhere.
 */
export function freeTakesLostAccess(store: Store, lock: PageLock, projectId?: string): void {
  const roles = new Map(store.accounts.activeAccounts().map((account) => [account.id, account.role]));
  for (const take of store.openTakes(projectId)) {
    if (take.accountId === "" || accountLevelIn(store, { id: take.accountId, role: roles.get(take.accountId) }, take.projectId) === "write") continue;
    releaseTake(store, lock, store.getThread(take.threadId)!);
    store.addTrace(take.threadId, { kind: "released", takerId: take.accountId });
  }
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
