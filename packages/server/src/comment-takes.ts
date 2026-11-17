import { threadTargetLabel, type TakeCommentsResponse, type TakenComment, type TerminalCommentsPage, type TerminalWaitingComment, type Thread } from "@redline/shared";
import type { SessionLabel } from "./terminal-sessions.js";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { zoneSubject } from "./thread-subject.js";
import { freshSessionMessage, threadMessage } from "./work.js";

/** The account that took the thread: "" for the shared token (no SSO), undefined when nobody took it. */
export const takerOf = (thread: Thread): string | undefined => (thread.take ? (thread.take.person?.id ?? "") : undefined);

/** What the account's own conversations are given for a thread it already took: the discussion so far, then what was written since its last answer. */
function takenMessage(thread: Thread): string {
  const lastAnswer = thread.replies.map((reply) => reply.author).lastIndexOf("claude");
  const since = thread.replies.slice(lastAnswer + 1).filter((reply) => reply.author !== "claude");
  return [freshSessionMessage(thread), ...(thread.relaunch ? ["", "New since your last answer:", ...since.flatMap((reply) => ["", reply.body])] : [])].join("\n");
}

/**
 * `pending_comments { pageId }`: the account takes every thread to take of the page, and every thread waiting for an offline agent
 * (which leaves the agent's queue), with the label of the conversation that asks, and is given them in the agent message form,
 * followed by the page's threads it had already taken (a relaunch marked as such).
 */
export function takeComments(store: Store, pageLock: PageLock, label: SessionLabel, pageId: string): TakeCommentsResponse {
  const page = store.getPage(pageId)!;
  const before = store.listThreads(pageId);
  const waitingForAgent = new Set(pageLock.withdrawWaitingForAgent(pageId));
  const fresh = (thread: Thread) => thread.toTake === true || waitingForAgent.has(thread.id);
  for (const thread of before.filter(fresh)) store.takeThread(thread.id, label.accountId, label.folder, label.machine);
  const comments: TakenComment[] = [];
  for (const thread of store.listThreads(pageId)) {
    if (thread.status !== "open" || takerOf(thread) !== label.accountId) continue;
    const wasFresh = fresh(before.find((t) => t.id === thread.id) ?? thread);
    comments.push(wasFresh ? { threadId: thread.id, state: "new", message: threadMessage(thread) } : { threadId: thread.id, state: thread.relaunch ? "relaunch" : "taken", message: takenMessage(thread) });
  }
  // What was just taken comes first.
  comments.sort((a, b) => Number(b.state === "new") - Number(a.state === "new"));
  return { pageId, title: page.title, comments };
}

const personLabel = (who: { person?: { name: string; email: string }; linkAuthor?: { name: string }; automatic?: true }): string =>
  who.automatic ? "Redline" : who.person ? who.person.name || who.person.email : (who.linkAuthor?.name ?? "Someone");

function waitingCommentOf(thread: Thread): TerminalWaitingComment {
  const target = thread.target.kind === "element" ? `${thread.target.artboard}, ${thread.target.elementName ?? thread.target.selector}` : thread.target.kind === "artboard" ? `${thread.target.artboard}, whole artboard` : thread.target.kind === "zone" ? zoneSubject(thread.target).replace(/^the /, "") : threadTargetLabel(thread.target);
  return { author: personLabel(thread), at: thread.createdAt, target, text: thread.body };
}

/** Every page `canRead` accepts (by project) with threads to take, and the threads. Takes nothing. */
export function commentsToTake(store: Store, canRead: (projectId: string) => boolean): TerminalCommentsPage[] {
  const pages: TerminalCommentsPage[] = [];
  for (const pageId of store.pageIdsWithOpenThreads()) {
    const page = store.getPage(pageId);
    if (!page || page.archivedAt || !canRead(page.projectId)) continue;
    const comments = store.listThreads(pageId).filter((thread) => thread.toTake).map(waitingCommentOf);
    if (comments.length > 0) pages.push({ pageId, title: page.title, projectTitle: store.getProject(page.projectId)?.title ?? "", comments });
  }
  return pages;
}
