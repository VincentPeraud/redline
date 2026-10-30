import { randomUUID } from "node:crypto";
import type { TerminalHolder, TerminalPickedPage } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";
import { dispatchToAgent } from "./work.js";

/** A terminal session with no heartbeat for this long is gone. */
export const TERMINAL_PRESENCE_TIMEOUT_MS = 60_000;

interface Presence {
  folder: string;
  machine: string;
  lastSeen: number;
}

/**
 * Which terminal sessions (`redline mcp`) are present, kept in memory from their heartbeats, and which present one holds each page.
 * A hold is persisted on the page but counts only while its session is present; when the session leaves, its holds are cleared.
 */
export class TerminalSessions {
  private readonly present = new Map<string, Presence>();
  /** Threads handed to a terminal session by `pick` and not answered yet. */
  private readonly picked = new Map<string, { sessionId: string; workId: string; pageId: string }>();
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

  heartbeat(sessionId: string, folder: string, machine: string): void {
    const wasPresent = this.present.has(sessionId);
    this.present.set(sessionId, { folder, machine, lastSeen: Date.now() });
    if (!wasPresent) this.announceHolds(sessionId);
  }

  bye(sessionId: string): void {
    if (this.present.delete(sessionId)) this.release(sessionId);
  }

  isPresent(sessionId: string): boolean {
    return this.present.has(sessionId);
  }

  /** The present session holding the page. */
  holderOf(pageId: string): TerminalHolder | undefined {
    const hold = this.store.holdOf(pageId);
    const session = hold && this.present.get(hold.sessionId);
    return hold && session ? { folder: session.folder, machine: session.machine, since: hold.since } : undefined;
  }

  /** Forgets the sessions without a recent heartbeat; after a restart, also the holds of sessions that never came back within the timeout. */
  sweep(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.present) {
      if (now - session.lastSeen <= this.timeoutMs) continue;
      this.present.delete(sessionId);
      this.release(sessionId);
    }
    if (now - this.startedAt <= this.timeoutMs) return;
    for (const { pageId } of this.store.heldPageIds(new Set(this.present.keys()))) this.drop(pageId);
  }

  /** The comments waiting for this session, per page: those of the pages it holds, and replies in threads it started. */
  waitingFor(sessionId: string): { pageId: string; title: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const { pageId, threadIds } of this.lock.terminalWaiting()) {
      if (this.waitsFor(sessionId, pageId, threadIds)) counts.set(pageId, (counts.get(pageId) ?? 0) + threadIds.length);
    }
    return [...counts].map(([pageId, count]) => ({ pageId, title: this.store.getPage(pageId)?.title ?? "", count }));
  }

  /**
   * Hands the comments waiting for this session over to it, per page: they leave the waiting list and each thread shows as being
   * handled, the session becoming the owner of every new thread. The messages are the ones an agent session would receive.
   */
  pick(sessionId: string): TerminalPickedPage[] {
    const items = this.lock.takeTerminalWork((item) => this.waitsFor(sessionId, item.pageId, item.threads.map((t) => t.threadId)));
    const pages = new Map<string, TerminalPickedPage>();
    for (const item of items) {
      const page = pages.get(item.pageId) ?? { pageId: item.pageId, title: this.store.getPage(item.pageId)?.title ?? "", messages: [] };
      page.messages.push(item.message);
      pages.set(item.pageId, page);
      for (const { threadId } of item.threads) {
        // One run per thread, so that answering one thread does not end the handling of the others of a batch.
        const workId = randomUUID();
        this.picked.set(threadId, { sessionId, workId, pageId: item.pageId });
        this.store.setTerminalOwner(threadId, sessionId);
        this.store.emit({ type: "work-dispatched", pageId: item.pageId, workId, threadIds: [threadId] });
      }
    }
    return [...pages.values()];
  }

  isPickedBy(threadId: string, sessionId: string): boolean {
    return this.picked.get(threadId)?.sessionId === sessionId;
  }

  /** The thread was answered: it is no longer being handled. */
  answered(threadId: string): void {
    const pick = this.picked.get(threadId);
    if (!pick) return;
    this.picked.delete(threadId);
    this.store.emit({ type: "work", message: { type: "work-done", workId: pick.workId } });
  }

  private waitsFor(sessionId: string, pageId: string, threadIds: string[]): boolean {
    return this.store.holdOf(pageId)?.sessionId === sessionId || threadIds.some((id) => this.store.getTerminalOwner(id) === sessionId);
  }

  private release(sessionId: string): void {
    for (const { pageId, sessionId: holder } of this.store.heldPageIds()) if (holder === sessionId) this.drop(pageId);
    // Replies waiting in threads this session started, on pages another session now holds.
    for (const { pageId } of this.lock.terminalWaiting()) {
      this.lock.releaseTerminalWork(pageId, (item) => item.threads.some((t) => this.store.getTerminalOwner(t.threadId) === sessionId));
    }
    this.returnPicked(sessionId);
  }

  /** The threads this session picked and never answered go to the agents, in a fresh session. */
  private returnPicked(sessionId: string): void {
    for (const [threadId, pick] of this.picked) {
      if (pick.sessionId !== sessionId) continue;
      this.picked.delete(threadId);
      const thread = this.store.getThread(threadId);
      const page = this.store.getPage(pick.pageId);
      if (thread && page && thread.status !== "resolved") dispatchToAgent(this.lock, page.projectId, thread);
    }
  }

  /** The page is no longer held: what waited for its terminal session goes to the agents. */
  private drop(pageId: string): void {
    this.store.clearHold(pageId);
    this.lock.releaseTerminalWork(pageId);
  }

  private announceHolds(sessionId: string): void {
    for (const { pageId, sessionId: holder } of this.store.heldPageIds()) if (holder === sessionId) this.store.emit({ type: "terminal-hold-changed", pageId });
  }
}
