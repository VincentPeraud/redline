import { INSTANCE_TAG_PREFIX, requestIsOpen, type ChangeRecord } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { tellOrigins } from "./diffusion-returns.js";
import { dispatchReply, type TerminalPresence } from "./work.js";
import { modelChoiceOf } from "./validation.js";

export type RefusalOutcome = { status: 200; body: { refused: string[] } } | { status: 400 | 404 | 409; body: { error: string } };

const NOT_OPEN = "Only a request still waiting for a diffusion can be refused.";

/** What the design system's session is asked, in the request thread, for the changes that must come out of the draft. */
export function undoMessage(tag: string, labels: string[], answer?: string): string {
  const said = answer ? ` The user says: ${answer}` : "";
  return `Refused: ${labels.join("; ")}. Undo only ${labels.length > 1 ? "these changes" : "this change"} in the draft of ${tag}, keep the other changes, then publish and call record_change once for ${tag} with this request as threadId (that publish is the undo).${said}`;
}

/** What the design system's session is told when a request is refused before it changed anything: there is nothing to undo, and nothing to do. */
export function droppedMessage(tag: string, answer?: string): string {
  return `The request on ${tag} was refused. Do not work on it: there is nothing to undo, so publish nothing for it and do not call record_change for it.${answer ? ` The user says: ${answer}` : ""}`;
}

/** The thread's session is asked to undo `labels`, as a message in the request thread. */
export function askToUndo(store: Store, pageLock: PageLock, terminal: TerminalPresence, threadId: string, labels: string[], answer?: string): void {
  const thread = store.getThread(threadId)!;
  const tag = `${INSTANCE_TAG_PREFIX}${thread.request!.component}`;
  const message = labels.length > 0 ? undoMessage(tag, labels, answer) : droppedMessage(tag, answer);
  dispatchReply(store, pageLock, store.getPage(thread.pageId)!.projectId, thread, message, modelChoiceOf({}), terminal);
}

/** A publish linked to a request already refused is a change to undo too: the session that published it is asked to take it out. */
export function askToUndoRefused(store: Store, pageLock: PageLock, terminal: TerminalPresence, recorded: ChangeRecord[]): void {
  const labelsByRequest = new Map<string, string[]>();
  for (const change of recorded) {
    if (change.state !== "refused" || !change.threadId) continue;
    const threadId = store.keptRequestId(change.threadId);
    labelsByRequest.set(threadId, [...(labelsByRequest.get(threadId) ?? []), change.label]);
  }
  for (const [threadId, labels] of labelsByRequest) askToUndo(store, pageLock, terminal, threadId, labels);
}

/** Posts the user's answer (else a line signed Redline), tells every origin of the request and asks the session to undo. */
function refuse(store: Store, pageLock: PageLock, terminal: TerminalPresence, threadId: string, labels: string[], whole: boolean, answer?: string): void {
  const request = store.getThread(threadId)!.request!;
  const tag = `${INSTANCE_TAG_PREFIX}${request.component}`;
  const subject = labels.length > 0 ? labels.join(" ; ") : `la demande sur ${tag}`;
  store.setRefusalAnswer(threadId, answer);
  if (answer) store.addReply(threadId, answer, "user");
  else store.addReply(threadId, `Refusé : ${subject}.`, "redline");
  const said = answer ? ` Réponse du design system : ${answer}` : "";
  tellOrigins(store, pageLock, terminal, threadId, `Refusé par le design system : ${subject}.${said} Garde l'instance la plus proche de ce que tu veux, ou propose un composant du projet si tu en as encore besoin.`);
  if (whole) store.setRequestState(threadId, "refused");
  else store.addRefusedLabels(threadId, labels);
  if (whole || labels.length > 0) askToUndo(store, pageLock, terminal, threadId, labels, answer);
  if (whole) store.resolveThread(threadId);
}

/** The request a refusable change answers (the kept one when it was merged), if it is still open. */
function openRequestOf(store: Store, change: ChangeRecord): string | undefined {
  if (!change.threadId) return undefined;
  const threadId = store.keptRequestId(change.threadId);
  const request = store.getThread(threadId)?.request;
  return request && requestIsOpen(request) ? threadId : undefined;
}

/** "Refuser" on one change born of a request (review, before / after). The request turns refused when none of its changes is left. */
export function refuseChange(store: Store, pageLock: PageLock, terminal: TerminalPresence, changeId: string, answer?: unknown): RefusalOutcome {
  if (answer !== undefined && typeof answer !== "string") return { status: 400, body: { error: "answer must be a string" } };
  const change = store.getChange(changeId);
  if (!change) return { status: 404, body: { error: "change not found" } };
  const threadId = change.state === "pending" ? openRequestOf(store, change) : undefined;
  if (!threadId) return { status: 409, body: { error: "Only a pending change born of a request can be refused." } };
  store.refuseChanges([change.id]);
  const left = store.pendingChangesOf(change.designSystemId, threadId).length;
  refuse(store, pageLock, terminal, threadId, [change.label], left === 0, answer?.trim());
  return { status: 200, body: { refused: [change.id] } };
}

/** "Refuser" on a request card: all its changes, and the request. */
export function refuseRequest(store: Store, pageLock: PageLock, terminal: TerminalPresence, threadId: string, answer?: unknown): RefusalOutcome {
  if (answer !== undefined && typeof answer !== "string") return { status: 400, body: { error: "answer must be a string" } };
  const thread = store.getThread(threadId);
  if (!thread?.request) return { status: 404, body: { error: "request not found" } };
  if (!requestIsOpen(thread.request)) return { status: 409, body: { error: NOT_OPEN } };
  const designSystemId = store.getPage(thread.pageId)!.projectId;
  const pending = store.pendingChangesOf(designSystemId, threadId);
  store.refuseChanges(pending.map((change) => change.id));
  refuse(store, pageLock, terminal, threadId, pending.map((change) => change.label), true, answer?.trim());
  return { status: 200, body: { refused: pending.map((change) => change.id) } };
}

/** "Relancer Claude" on a change awaiting its undo: the session is asked again, with the same message and the user's answer if any. */
export function relaunchUndo(store: Store, pageLock: PageLock, terminal: TerminalPresence, changeId: string): RefusalOutcome {
  const change = store.getChange(changeId);
  if (!change) return { status: 404, body: { error: "change not found" } };
  const threadId = change.state === "refused" && change.threadId ? store.keptRequestId(change.threadId) : undefined;
  if (!threadId || !store.getThread(threadId)?.request) return { status: 409, body: { error: "Only a refused change awaiting its undo can be sent again." } };
  const refused = store.refusedChangesOf(change.designSystemId, threadId);
  askToUndo(store, pageLock, terminal, threadId, refused.map((item) => item.label), store.getThread(threadId)!.request!.refusalAnswer);
  return { status: 200, body: { refused: refused.map((item) => item.id) } };
}
