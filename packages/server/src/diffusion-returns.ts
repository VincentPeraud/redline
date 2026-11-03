import { INSTANCE_TAG_PREFIX, requestIsOpen, type RequestOrigin, type Thread } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { dispatchReply, dispatchThread, type TerminalPresence } from "./work.js";
import { modelChoiceOf } from "./validation.js";

/** An open request that a pending change answers: it closes with the next diffusion. */
export interface ClosingRequest {
  threadId: string;
  component: string;
  /** The labels of its pending changes. */
  labels: string[];
  /** The labels of the changes the user refused on it: the return recalls them. */
  refused: string[];
}

/** The open requests answered by a change recorded since the current diffusion (read before the diffusion is made). */
export function requestsClosedBy(store: Store, designSystemId: string): ClosingRequest[] {
  const closing = new Map<string, ClosingRequest>();
  for (const change of store.listChanges(designSystemId)) {
    if (change.state !== "pending" || !change.threadId) continue;
    // A change linked to a request merged into another answers the one that stayed open.
    const threadId = store.getThread(change.threadId)?.request?.mergedInto ?? change.threadId;
    const request = store.getThread(threadId)?.request;
    if (!request || !requestIsOpen(request)) continue;
    const entry = closing.get(threadId) ?? { threadId, component: request.component, labels: [], refused: request.refusedLabels ?? [] };
    if (!entry.labels.includes(change.label)) entry.labels.push(change.label);
    closing.set(threadId, entry);
  }
  return [...closing.values()];
}

/** What Redline tells the origin thread: what is now available, and what to do with it. */
export function returnMessage(request: ClosingRequest, diffusionNumber: number): string {
  const available = `${request.labels.join(" ; ")} : disponible dans ${INSTANCE_TAG_PREFIX}${request.component} depuis la diffusion ${diffusionNumber}. Mets l'instance à jour.`;
  return request.refused.length > 0 ? `${available} Refusé : ${request.refused.join(" ; ")}.` : available;
}

const isArchived = (store: Store, pageId: string): boolean => {
  const page = store.getPage(pageId);
  return !page || page.archivedAt !== undefined || store.isArchived(page.projectId);
};

/**
 * Tells the page an origin sits on what is now available. The user's comment that started the request reopens with a
 * Redline message; an origin with no such comment gets a thread on the instance, signed Redline. Either way it goes to
 * the project's agent. Returns false when the page is archived or gone (nothing is written).
 */
export function returnToOrigin(store: Store, pageLock: PageLock, terminal: TerminalPresence, origin: RequestOrigin, message: string): boolean {
  const page = store.getPage(origin.pageId);
  if (!page || isArchived(store, origin.pageId)) return false;
  const existing = origin.threadId ? store.getThread(origin.threadId) : undefined;
  if (existing && existing.pageId === origin.pageId) {
    store.reopenThread(existing.id);
    store.addReply(existing.id, message, "redline");
    // Routed like a reply: it resumes the session that owns the thread, else a session starts from the thread's history.
    dispatchReply(store, pageLock, page.projectId, existing, message, modelChoiceOf({}), terminal, "Redline");
    return true;
  }
  const target = origin.selector ? { artboard: origin.artboard, selector: origin.selector, xPct: 0, yPct: 0 } : { target: { kind: "artboard" as const, artboard: origin.artboard } };
  const thread: Thread = store.createThread(origin.pageId, { ...target, title: "Disponible dans le design system", body: message }, undefined, true);
  dispatchThread(pageLock, page.projectId, thread, modelChoiceOf({}), terminal);
  return true;
}

/**
 * After a diffusion: closes each request answered by it (`diffused`, resolved so it leaves the lists) and returns to each
 * of its origins. An origin on an archived page keeps its message until the page is unarchived (`returnPendingOn`);
 * the request's thread says so.
 */
export function closeDiffusedRequests(store: Store, pageLock: PageLock, terminal: TerminalPresence, closing: ClosingRequest[], diffusionNumber: number): void {
  for (const request of closing) {
    const message = returnMessage(request, diffusionNumber);
    store.setRequestState(request.threadId, "diffused");
    store.resolveThread(request.threadId);
    tellOrigins(store, pageLock, terminal, request.threadId, message);
  }
}

/**
 * Tells every origin of a request `message` (a diffusion, a refusal). An origin on an archived page keeps its message until
 * the page is unarchived (`returnPendingOn`); the request's thread says so.
 */
export function tellOrigins(store: Store, pageLock: PageLock, terminal: TerminalPresence, threadId: string, message: string): void {
  store.getThread(threadId)!.request!.origins.forEach((origin, index) => {
    if (returnToOrigin(store, pageLock, terminal, origin, message)) return;
    store.setPendingReturn(threadId, index, message);
    store.addReply(threadId, `Pas de fil de retour pour ${origin.projectTitle} · ${origin.pageTitle} : page archivée. Il s'ouvrira si la page est désarchivée.`, "redline");
  });
}

/** The pages are back: the messages their origins were waiting for are delivered. */
export function returnPendingOn(store: Store, pageLock: PageLock, terminal: TerminalPresence, pageIds: ReadonlySet<string>): void {
  for (const { threadId, originIndex, origin, message } of store.pendingReturnsOn(pageIds)) {
    if (!returnToOrigin(store, pageLock, terminal, origin, message)) continue;
    store.setPendingReturn(threadId, originIndex, undefined);
  }
}
