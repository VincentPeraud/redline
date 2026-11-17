import {
  threadTargetLabel,
  type AccessLevel,
  type CommentsOverview,
  type CommentsReminder,
  type OtherTake,
  type OverviewPage,
  type OverviewProject,
  type RefusedThread,
  type ReleaseCommentsResponse,
  type TakeCommentsResponse,
  type TakenComment,
  type TerminalCommentsPage,
  type TerminalWaitingComment,
  type Thread,
} from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { SessionLabel } from "./terminal-sessions.js";
import type { Store } from "./store.js";
import { zoneSubject } from "./thread-subject.js";
import { freshSessionMessage } from "./work.js";

/** The account that took the thread: "" for the shared token (no SSO), undefined when nobody took it. */
export const takerOf = (thread: Thread): string | undefined => (thread.take ? (thread.take.person?.id ?? "") : undefined);

export interface TakeEnv {
  store: Store;
  pageLock: PageLock;
  /** The account's real level on a project (an agent token reads its person's, not only where it writes). */
  levelOf(projectId: string): AccessLevel | undefined;
}

const canWritePage = (env: TakeEnv, pageId: string): boolean => env.levelOf(env.store.projectIdOfPage(pageId)!) === "write";

/** What the account's own conversations are given for a thread it already took: the discussion so far, then what was written since its last answer (or since the take when it never answered). */
function takenMessage(thread: Thread): string {
  const lastAnswer = thread.replies.map((reply) => reply.author).lastIndexOf("claude");
  const since = thread.replies.slice(lastAnswer + 1).filter((reply) => reply.author !== "claude");
  if (thread.relaunch) return [freshSessionMessage(thread), "", "New since your last answer:", ...since.flatMap((reply) => ["", reply.body])].join("\n");
  const newSinceTake = lastAnswer === -1 && thread.take ? since.filter((reply) => reply.createdAt > thread.take!.takenAt) : [];
  return [freshSessionMessage(thread), ...(newSinceTake.length > 0 ? ["", "New since your take:", ...newSinceTake.flatMap((reply) => ["", reply.body])] : [])].join("\n");
}

const accountName = (store: Store, accountId: string): string => {
  const person = store.getPerson(accountId || null);
  return person ? person.name || person.email : "the shared account";
};

/** Why the account cannot take or release comments on the project (undefined when it can). */
export function writeRefusal(store: Store, accountId: string, level: AccessLevel | undefined, projectId: string): string | undefined {
  if (level === "write") return undefined;
  const title = store.getProject(projectId)?.title ?? "";
  const has = level === "comment" ? "the Commentaire right" : level === "read" ? "the Lecture right" : "no access";
  return `Refused: your account (${accountName(store, accountId)}) has ${has} on the project ${JSON.stringify(title)}. Taking a thread needs the Écriture right: ask an admin of the project for it.`;
}

const targetLabel = (thread: Thread): string =>
  thread.target.kind === "element"
    ? `${thread.target.artboard}, ${thread.target.elementName ?? thread.target.selector}`
    : thread.target.kind === "artboard"
      ? `${thread.target.artboard}, whole artboard`
      : thread.target.kind === "zone"
        ? zoneSubject(thread.target).replace(/^the /, "")
        : threadTargetLabel(thread.target);

const otherTakeOf = (store: Store, thread: Thread, pageTitle: string): OtherTake => ({
  threadId: thread.id,
  number: thread.number,
  pageId: thread.pageId,
  pageTitle,
  target: targetLabel(thread),
  by: accountName(store, takerOf(thread)!),
  folder: thread.take!.folder,
  takenAt: thread.take!.takenAt,
});

/** An open thread nobody handles that only waits in the queue for an offline agent. */
const waitsForAgent = (env: TakeEnv, thread: Thread): boolean => thread.status === "open" && !thread.take && env.pageLock.isWaitingForAgent(thread.id);

/** Takes the thread for the account, withdrawing it from the queue first when it waited for an offline agent. */
function take(env: TakeEnv, label: SessionLabel, thread: Thread, takenOverFrom?: string): void {
  env.pageLock.withdrawWaiting(thread.id);
  env.store.takeThread(thread.id, label.accountId, label.folder, label.machine, takenOverFrom);
}

function commentOf(env: TakeEnv, thread: Thread, state: TakenComment["state"], previous?: Thread): TakenComment {
  const page = env.store.getPage(thread.pageId)!;
  const base = { threadId: thread.id, pageId: page.id, pageTitle: page.title, state };
  const current = env.store.getThread(thread.id)!;
  if (state === "taken" || state === "relaunch") return { ...base, folder: current.take!.folder, takenAt: current.take!.takenAt, message: takenMessage(current) };
  if (state === "taken-over") return { ...base, ...(previous?.take ? { from: accountName(env.store, takerOf(previous)!) } : {}), message: freshSessionMessage(current) };
  return { ...base, message: freshSessionMessage(current) };
}

/**
 * `pending_comments { pageId }`: the account takes every thread to take of the page (and those waiting for an offline agent), with the
 * label of the conversation that asks, and is given them in the agent message form, followed by the page's threads it had already taken.
 * The threads other accounts took are listed apart.
 */
export function takePage(env: TakeEnv, label: SessionLabel, pageId: string): TakeCommentsResponse {
  const { store } = env;
  const page = store.getPage(pageId)!;
  const fresh = new Map<string, TakenComment["state"]>();
  for (const thread of store.listThreads(pageId)) {
    if (thread.toTake) fresh.set(thread.id, "new");
    else if (waitsForAgent(env, thread)) fresh.set(thread.id, "waiting-agent");
    else continue;
    take(env, label, thread);
  }
  const comments: TakenComment[] = [];
  const others: OtherTake[] = [];
  for (const thread of store.listThreads(pageId)) {
    if (thread.status !== "open" || !thread.take) continue;
    if (takerOf(thread) === label.accountId) comments.push(commentOf(env, thread, fresh.get(thread.id) ?? (thread.relaunch ? "relaunch" : "taken")));
    else others.push(otherTakeOf(store, thread, page.title));
  }
  // What was just taken comes first.
  const rank = (comment: TakenComment) => (comment.state === "new" ? 0 : comment.state === "waiting-agent" ? 1 : 2);
  comments.sort((a, b) => rank(a) - rank(b));
  return { pageId, title: page.title, comments, others, refused: [] };
}

/**
 * `pending_comments { threadIds, takeOver? }`: takes those threads. A thread another account took needs `takeOver` (recorded as
 * "repris par"); a thread an agent is running is refused; the thread of an idle agent session can be taken over too.
 */
export function takeThreads(env: TakeEnv, label: SessionLabel, threadIds: string[], takeOver: boolean): TakeCommentsResponse {
  const { store, pageLock } = env;
  const comments: TakenComment[] = [];
  const refused: RefusedThread[] = [];
  for (const threadId of threadIds) {
    const thread = store.getThread(threadId);
    const no = (reason: string) => void refused.push({ threadId, reason });
    if (!thread) no("thread not found");
    else if (!canWritePage(env, thread.pageId)) no(writeRefusal(store, label.accountId, env.levelOf(store.projectIdOfPage(thread.pageId)!), store.projectIdOfPage(thread.pageId)!)!);
    else if (thread.status !== "open") no("this thread is not open (resolved or deleted): nothing to take");
    else if (thread.take && takerOf(thread) === label.accountId) comments.push(commentOf(env, thread, thread.relaunch ? "relaunch" : "taken"));
    else if (thread.toTake) {
      take(env, label, thread);
      comments.push(commentOf(env, thread, "new"));
    } else if (waitsForAgent(env, thread)) {
      take(env, label, thread);
      comments.push(commentOf(env, thread, "waiting-agent"));
    } else if (pageLock.hasWorkFor(thread.id)) no("an agent is running this thread: wait for its run to end, nothing is taken meanwhile");
    else if (!takeOver) no(thread.take ? `taken by ${accountName(store, takerOf(thread)!)} (${thread.take.folder}): take it over only when the person asks, with takeOver: true` : "owned by an agent session: take it over only when the person asks, with takeOver: true");
    else {
      const previous = takerOf(thread);
      store.clearThreadSession(thread.id);
      take(env, label, thread, previous ?? "");
      store.addTrace(thread.id, { kind: "taken-over", ...(previous === undefined ? {} : { takerId: previous }), byId: label.accountId });
      comments.push(commentOf(env, thread, "taken-over", thread));
    }
  }
  return { comments, others: [], refused };
}

/** `pending_comments` with neither a page nor thread ids: lists, page by page, what waits in the projects, and takes nothing. */
export function commentsOverview(env: TakeEnv, label: SessionLabel, projectIds: string[], levelOf: (projectId: string) => AccessLevel | undefined): CommentsOverview {
  const { store } = env;
  const projects: OverviewProject[] = [];
  for (const projectId of projectIds) {
    const project = store.getProject(projectId);
    if (!project || project.archivedAt) continue;
    const pages = store.listPages(projectId, "active");
    const base = { projectId, title: project.title, pageCount: pages.length };
    const refusal = writeRefusal(store, label.accountId, levelOf(projectId), projectId);
    if (refusal) {
      projects.push({ ...base, refused: refusal, pages: [] });
      continue;
    }
    const listed: OverviewPage[] = [];
    for (const page of pages) {
      const entry: OverviewPage = { pageId: page.id, title: page.title, toTake: [], mine: [], mineElsewhere: [], others: [], waitingAgent: [] };
      for (const thread of store.listThreads(page.id)) {
        if (thread.status !== "open") continue;
        const brief = { threadId: thread.id, number: thread.number, target: targetLabel(thread) };
        if (thread.toTake) entry.toTake.push(brief);
        else if (waitsForAgent(env, thread)) entry.waitingAgent.push(brief);
        else if (thread.take && takerOf(thread) === label.accountId) {
          if (thread.take.folder === label.folder) entry.mine.push({ ...brief, ...(thread.relaunch ? { relaunch: true as const } : {}) });
          else entry.mineElsewhere.push({ ...brief, folder: thread.take.folder, takenAt: thread.take.takenAt });
        } else if (thread.take) entry.others.push({ ...brief, by: accountName(store, takerOf(thread)!), folder: thread.take.folder, takenAt: thread.take.takenAt });
      }
      if (entry.toTake.length + entry.mine.length + entry.mineElsewhere.length + entry.others.length + entry.waitingAgent.length > 0) listed.push(entry);
    }
    projects.push({ ...base, pages: listed });
  }
  return { projects };
}

/**
 * `release_comments`: the account lets go of its takes; each thread follows the page's mode again (`redispatch` sends it to the agent in Agent mode).
 * `threadIds` the account does not hold are reported, never touched.
 */
export function releaseComments(env: TakeEnv, label: SessionLabel, request: { pageId?: string; threadIds?: string[] }, redispatch: (thread: Thread) => void): ReleaseCommentsResponse {
  const { store } = env;
  const wanted = request.threadIds ?? store.listThreads(request.pageId!).filter((thread) => thread.take && thread.status === "open").map((thread) => thread.id);
  const released: ReleaseCommentsResponse["released"] = [];
  const notYours: string[] = [];
  for (const threadId of wanted) {
    const thread = store.getThread(threadId);
    if (!thread?.take || takerOf(thread) !== label.accountId) {
      if (request.threadIds) notYours.push(threadId);
      continue;
    }
    store.releaseThreadTake(threadId);
    released.push({ threadId, number: thread.number, pageTitle: store.getPage(thread.pageId)?.title ?? "" });
    const after = store.getThread(threadId)!;
    if (after.status === "open") redispatch(after);
  }
  return { released, notYours };
}

/** What ends the answers of a conversation: threads to take and relaunches for the account, on the pages its folder published or checked out. */
export function remindersOf(env: TakeEnv, label: SessionLabel): CommentsReminder {
  const { store } = env;
  const pages: CommentsReminder["pages"] = [];
  for (const pageId of store.terminalPagesOf(label.accountId, label.folder)) {
    const page = store.getPage(pageId);
    if (!page || page.archivedAt || !canWritePage(env, pageId)) continue;
    const count = store.listThreads(pageId).filter((thread) => thread.status === "open" && (thread.toTake || (thread.relaunch && takerOf(thread) === label.accountId && thread.take!.folder === label.folder))).length;
    if (count > 0) pages.push({ pageId, title: page.title, count });
  }
  return { pages };
}

const personLabel = (who: { person?: { name: string; email: string }; linkAuthor?: { name: string }; automatic?: true }): string =>
  who.automatic ? "Redline" : who.person ? who.person.name || who.person.email : (who.linkAuthor?.name ?? "Someone");

function waitingCommentOf(thread: Thread): TerminalWaitingComment {
  const taken = thread.take && { by: thread.take.person ? thread.take.person.name || thread.take.person.email : "", folder: thread.take.folder };
  return { author: personLabel(thread), at: thread.createdAt, target: targetLabel(thread), text: thread.body, ...(taken ? { taken } : {}) };
}

/** Every page `canRead` accepts (by project) with open threads to take or taken, and the threads. Takes nothing. */
export function commentsToTake(store: Store, canRead: (projectId: string) => boolean): TerminalCommentsPage[] {
  const pages: TerminalCommentsPage[] = [];
  for (const pageId of store.pageIdsWithOpenThreads()) {
    const page = store.getPage(pageId);
    if (!page || page.archivedAt || !canRead(page.projectId)) continue;
    const comments = store.listThreads(pageId).filter((thread) => thread.status === "open" && (thread.toTake || thread.take)).map(waitingCommentOf);
    if (comments.length > 0) pages.push({ pageId, title: page.title, projectTitle: store.getProject(page.projectId)?.title ?? "", comments });
  }
  return pages;
}
