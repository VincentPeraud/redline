import type { Person, TerminalHolder, TerminalPickedPage, WorkItem } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { dispatchToAgent, type TerminalPresence } from "./work.js";

/** A terminal session with no heartbeat for this long is gone. */
export const TERMINAL_PRESENCE_TIMEOUT_MS = 60_000;

/** `/Users/ana/work/site` (or `/home/ana/…`, `C:\Users\ana\…`) shows as `~/work/site`: the login is not served. */
const HOME_PREFIX = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;
const homeShortened = (folder: string) => folder.replace(HOME_PREFIX, "~");

interface Presence {
  folder: string;
  machine: string;
  lastSeen: number;
}

export interface WaitingOnPage {
  pageId: string;
  title: string;
  count: number;
}

/**
 * Which terminal sessions (`redline mcp`) are present, kept in memory from their heartbeats, and which present one holds each page.
 * A hold is persisted on the page but counts only while its session is present; when the session leaves, its holds are cleared.
 *
 * Work waiting for a terminal session belongs to one session: the terminal session of its thread when the thread has one (a reply),
 * else the holder of its page (a new thread). Only that session waits for it, picks it, and releases it when it leaves.
 * A pick (a thread a session took with `pending_comments` and has not answered) is persisted on the thread, so that it survives a restart.
 */
export class TerminalSessions implements TerminalPresence {
  private readonly present = new Map<string, Presence>();
  private readonly startedAt = Date.now();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly lock: PageLock,
    private readonly timeoutMs: number = TERMINAL_PRESENCE_TIMEOUT_MS,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.max(20, Math.floor(timeoutMs / 4)));
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** After a restart: the threads picked before it show as being worked on again, until their session answers or the window passes. */
  restore(): void {
    for (const { pageId, runId, threadId } of this.store.terminalPicks()) this.lock.showTerminalRun(pageId, runId, threadId);
  }

  heartbeat(sessionId: string, folder: string, machine: string): void {
    const wasPresent = this.present.has(sessionId);
    this.present.set(sessionId, { folder, machine, lastSeen: Date.now() });
    if (!wasPresent) this.announceHolds(sessionId);
  }

  bye(sessionId: string): void {
    if (this.present.delete(sessionId)) this.releaseSessions((id) => id === sessionId);
  }

  isPresent(sessionId: string): boolean {
    return this.present.has(sessionId);
  }

  holdsPage(pageId: string): boolean {
    const hold = this.store.holdOf(pageId);
    return hold !== undefined && this.present.has(hold.sessionId);
  }

  /** The present session holding the page. */
  holderOf(pageId: string): TerminalHolder | undefined {
    const hold = this.store.holdOf(pageId);
    const session = hold && this.present.get(hold.sessionId);
    if (!hold || !session) return undefined;
    const waiting = this.waitingFor(hold.sessionId).find((w) => w.pageId === pageId)?.count ?? 0;
    return { folder: homeShortened(session.folder), machine: session.machine, since: hold.since, waiting };
  }

  /** Forgets the sessions without a recent heartbeat; after a restart, also what belongs to sessions that never came back within the timeout. */
  sweep(): void {
    const now = Date.now();
    const quiet = new Set<string>();
    for (const [sessionId, session] of this.present) {
      if (now - session.lastSeen <= this.timeoutMs) continue;
      this.present.delete(sessionId);
      quiet.add(sessionId);
    }
    if (now - this.startedAt > this.timeoutMs) this.releaseSessions((id) => !this.present.has(id));
    else if (quiet.size > 0) this.releaseSessions((id) => quiet.has(id));
  }

  /** The comments waiting for this session, per page. */
  waitingFor(sessionId: string): WaitingOnPage[] {
    const counts = new Map<string, number>();
    for (const { pageId, threadIds } of this.lock.terminalWaiting()) {
      if (this.sessionOf(pageId, threadIds) === sessionId) counts.set(pageId, (counts.get(pageId) ?? 0) + threadIds.length);
    }
    return [...counts].map(([pageId, count]) => ({ pageId, title: this.titleOf(pageId), count }));
  }

  /**
   * The hold on the page ends and what waited for its terminal session goes to the agents, until a terminal session publishes again.
   * A person releases the whole page (`handedOverBy`); a session (`onlySession`) releases its own work and threads only.
   */
  releasePage(pageId: string, { handedOverBy, onlySession }: { handedOverBy?: Person; onlySession?: string } = {}): void {
    this.lock.releaseTerminalWork((item) => item.pageId === pageId && (onlySession === undefined || this.sessionOf(item.pageId, item.threads.map((t) => t.threadId)) === onlySession), handedOverBy);
    this.store.clearHold(pageId);
    const picked = new Set(this.store.terminalPicks().map((p) => p.threadId));
    for (const thread of this.store.listThreads(pageId)) {
      const session = this.store.getThreadTerminalSession(thread.id);
      if (session && !picked.has(thread.id) && (onlySession === undefined || session === onlySession)) this.store.clearThreadTerminalSession(thread.id);
    }
  }

  /** `release_page`: hands over one page this session holds, or all of them. Returns what was handed over; a page the session does not hold is not in it. */
  releaseHeldBy(sessionId: string, pageId?: string): WaitingOnPage[] {
    const waiting = new Map(this.waitingFor(sessionId).map((w) => [w.pageId, w.count]));
    const held = this.store
      .heldPages()
      .filter((h) => h.sessionId === sessionId && (pageId === undefined || h.pageId === pageId))
      .map((h) => ({ pageId: h.pageId, title: this.titleOf(h.pageId), count: waiting.get(h.pageId) ?? 0 }));
    for (const page of held) this.releasePage(page.pageId, { onlySession: sessionId });
    return held;
  }

  /**
   * Hands the comments waiting for this session over to it, per page: they leave the waiting list and each thread shows as being
   * handled, the session becoming the terminal session of every new thread. The messages are the ones an agent session would receive.
   */
  pick(sessionId: string): TerminalPickedPage[] {
    const taken = this.lock.takeTerminalWork((item) => this.sessionOf(item.pageId, item.threads.map((t) => t.threadId)) === sessionId);
    const pages = new Map<string, TerminalPickedPage>();
    for (const { item, runs } of taken) {
      const page = pages.get(item.pageId) ?? { pageId: item.pageId, title: this.titleOf(item.pageId), messages: [] };
      page.messages.push(item.message);
      pages.set(item.pageId, page);
      for (const { threadId, workId } of runs) this.store.pickThreadForTerminalSession(threadId, sessionId, workId);
    }
    return [...pages.values()];
  }

  isPickedBy(threadId: string, sessionId: string): boolean {
    return this.store.terminalPicks().some((p) => p.threadId === threadId && p.sessionId === sessionId);
  }

  /** The thread was answered: it is no longer being handled. */
  answered(threadId: string): void {
    const pick = this.store.terminalPicks().find((p) => p.threadId === threadId);
    if (!pick) return;
    this.store.endTerminalPick(threadId);
    this.lock.endTerminalRun(pick.runId);
    // The page was released while the session worked: its later replies go to the agents.
    if (!this.store.holdOf(pick.pageId)) this.store.clearThreadTerminalSession(threadId);
  }

  /** The terminal session the work waits for: the one of its thread (a reply), else the holder of its page (a new thread). */
  private sessionOf(pageId: string, threadIds: string[]): string | undefined {
    for (const threadId of threadIds) {
      const session = this.store.getThreadTerminalSession(threadId);
      if (session) return session;
    }
    return this.store.holdOf(pageId)?.sessionId;
  }

  /** What belongs to the sessions `gone` accepts goes to the agents: their waiting work, their holds, their unanswered picks. */
  private releaseSessions(gone: (sessionId: string) => boolean): void {
    const belongsToGone = (item: WorkItem) => {
      const session = this.sessionOf(item.pageId, item.threads.map((t) => t.threadId));
      return session === undefined || gone(session);
    };
    this.lock.releaseTerminalWork(belongsToGone);
    for (const { pageId, sessionId } of this.store.heldPages()) if (gone(sessionId)) this.store.clearHold(pageId);
    for (const pick of this.store.terminalPicks()) if (gone(pick.sessionId)) this.returnPick(pick);
  }

  /** A thread its session picked and never answered goes to the agents, in a fresh session. */
  private returnPick({ threadId, pageId, runId }: { threadId: string; pageId: string; runId: string }): void {
    this.lock.endTerminalRun(runId, "The terminal session left before answering.");
    this.store.clearThreadTerminalSession(threadId);
    const thread = this.store.getThread(threadId);
    const page = this.store.getPage(pageId);
    if (thread && page && thread.status !== "resolved") dispatchToAgent(this.lock, page.projectId, thread);
  }

  private titleOf(pageId: string): string {
    return this.store.getPage(pageId)?.title ?? "";
  }

  private announceHolds(sessionId: string): void {
    for (const { pageId, sessionId: holder } of this.store.heldPages()) if (holder === sessionId) this.store.emit({ type: "terminal-hold-changed", pageId });
  }
}
