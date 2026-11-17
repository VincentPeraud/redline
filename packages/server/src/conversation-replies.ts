import { relativeTime, type LateReplyReason, type Person, type Thread, type ThreadReply } from "@redline/shared";
import { takerOf } from "./comment-takes.js";
import type { SessionLabel } from "./terminal-sessions.js";
import type { Store } from "./store.js";

const nameOf = (person: Person | undefined): string => person?.name || person?.email || "quelqu'un";

const lastTrace = (thread: Thread, accountId: string, kinds: ("handed-over" | "taken-over")[]) =>
  thread.traces?.filter((trace) => kinds.includes(trace.kind as "handed-over" | "taken-over") && (trace.taker?.id ?? "") === accountId).at(-1);

/** What a conversation's answer to a thread means for the thread, as the answer adds it: the reason it is late, and what Claude is told. */
function situation(thread: Thread, label: SessionLabel): { late?: LateReplyReason; note?: string } {
  if (thread.status === "resolved") {
    const by = thread.resolvedBy;
    const when = thread.resolvedAt ? ` ${relativeTime(thread.resolvedAt)}` : "";
    const resolved = by ? `Ce fil est résolu : ${by.id === label.accountId ? "tu l'as résolu" : `${nameOf(by)} l'a résolu`}${when}.` : `Ce fil est résolu${when}.`;
    return { late: "resolved", note: `${resolved} Ta réponse est ajoutée, il reste résolu.` };
  }
  const mine = takerOf(thread) === label.accountId;
  if (mine) return {};
  const handedOver = lastTrace(thread, label.accountId, ["handed-over"]);
  const takenOver = lastTrace(thread, label.accountId, ["taken-over"]);
  const trace = [handedOver, takenOver].filter((t) => t !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (trace?.kind === "handed-over" && takerOf(thread) === undefined) return { late: "handed-over", note: `Il n'est plus à toi : ${nameOf(trace.by)} l'a confié à l'agent ${relativeTime(trace.createdAt)}. L'agent verra ta réponse.` };
  if (trace?.kind === "taken-over" && takerOf(thread) !== undefined) return { late: "taken-over", note: `Il n'est plus à toi : ${nameOf(trace.by)} l'a repris ${relativeTime(trace.createdAt)}. Sa conversation verra ta réponse.` };
  if (thread.take) return { note: `Ce fil est à ${nameOf(thread.take.person)} (${thread.take.folder}) : ta réponse est ajoutée au fil, sa prise ne change pas.` };
  return { note: "Ce fil est à l'agent : ta réponse est ajoutée au fil, l'agent la verra." };
}

/**
 * The answer of a Claude Code conversation to a thread, wherever the thread is now: added, signed, and the thread's handler untouched
 * (a thread to take is taken by the conversation's account; a resolved one stays resolved). `resolve` closes it, with a trace when
 * another account held it. Held and "À relire" threads are not Claude's yet.
 */
export function replyFromConversation(store: Store, thread: Thread, label: SessionLabel, body: string, resolve: boolean | undefined): { reply: ThreadReply; note?: string } | { error: string } {
  if (thread.status === "held" || thread.status === "review") return { error: "Ce fil n'a pas encore été envoyé à Claude : on ne peut pas y répondre." };
  if (thread.toTake) store.takeThread(thread.id, label.accountId, label.folder, label.machine);
  const { late, note } = thread.toTake ? ({} as { late?: LateReplyReason; note?: string }) : situation(thread, label);
  const conversation = { ...(label.accountId ? { personId: label.accountId } : {}), folder: label.folder, ...(late ? { late } : {}) };
  const reply = store.addReply(thread.id, body, "claude", [], undefined, undefined, conversation)!;
  if (resolve && thread.status !== "resolved") store.resolveThread(thread.id, label.accountId);
  return { reply, ...(note ? { note } : {}) };
}
