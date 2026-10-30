import type { TerminalHolder } from "@redline/shared";
import type { PageLock } from "./page-lock.js";
import type { Store } from "./store.js";

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

  /** The comments waiting for the pages this session holds, per page. */
  waitingFor(sessionId: string): { pageId: string; title: string; count: number }[] {
    const held = new Set(this.store.heldPageIds().filter((h) => h.sessionId === sessionId).map((h) => h.pageId));
    const counts = new Map<string, number>();
    for (const { pageId, threadIds } of this.lock.terminalWaiting()) if (held.has(pageId)) counts.set(pageId, (counts.get(pageId) ?? 0) + threadIds.length);
    return [...counts].map(([pageId, count]) => ({ pageId, title: this.store.getPage(pageId)?.title ?? "", count }));
  }

  private release(sessionId: string): void {
    for (const { pageId, sessionId: holder } of this.store.heldPageIds()) if (holder === sessionId) this.drop(pageId);
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
