import type { QueueEntry, QueueReason, WorkItem } from "@redline/shared";
import { chooseAgent } from "./agent-selection.js";
import type { AgentHub } from "./agents.js";
import { RETRY_DELAYS_MS, UNKNOWN_RESET_WAIT_MS, isSubscriptionLimit, limitResetAt } from "./retry-policy.js";
import type { Store } from "./store.js";

export interface SubmitOptions {
  projectId: string;
  /** Only this agent may run the item (a resumed session lives on the agent that opened it). Default: the project's online agent. */
  agentId?: string;
  /** What to send instead (a fresh session) when the pinned agent is offline and the global agent takes over. Without it a pinned item just waits. */
  takeoverItem?: WorkItem;
  /** Called each time an item is sent to an agent, with the item actually sent (`takeoverItem` or the original). */
  onDispatched?(agentId: string, item: WorkItem): void;
}

interface Queued extends SubmitOptions {
  item: WorkItem;
}

interface Active {
  queued: Queued;
  agentId: string;
}

/**
 * The single dispatch path for work items. The server grants at most one active work item per page
 * (threads, conversations and terminal mode alike); other items wait in submission order, and
 * items of different pages run in parallel. An item also waits while its project has no online agent.
 * State is in memory: a server restart forgets queued and active items.
 */
export class PageLock {
  private queue: Queued[] = [];
  private readonly active = new Map<string, Active>();
  /** Failed items waiting for their next try; they do not hold the page meanwhile. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  /** Items that failed for good, kept so "Relancer" can put them back in the queue. */
  private readonly failed = new Map<string, Queued>();

  constructor(
    private readonly store: Store,
    private readonly hub: AgentHub,
    private readonly retryDelaysMs: number[] = RETRY_DELAYS_MS,
  ) {
    store.onChange((event) => {
      if (event.type !== "work") return;
      if (event.message.type === "work-done") {
        this.attempts.delete(event.message.workId);
        this.release(event.message.workId);
      } else if (event.message.type === "work-failed") {
        this.fail(event.message.workId, event.message.message);
      }
    });
    hub.onAgentOnline(() => this.pump());
    hub.onAgentOffline((agentId) => this.requeueActiveOf(agentId));
  }

  /** Queues a work item for its page; it is sent to the project's agent (or `options.agentId`) as soon as the page is free and that agent is online. */
  submit(options: SubmitOptions, item: WorkItem): void {
    this.queue.push({ ...options, item });
    this.pump();
  }

  /** Frees the page held by a finished work item (done or failed) and starts the next one. Unknown ids are ignored. */
  release(workId: string): void {
    if (!this.active.delete(workId)) return;
    this.pump();
  }

  /** Puts an item that failed for good back in the queue of its page. False when `workId` is not such an item. */
  retry(workId: string): boolean {
    const queued = this.failed.get(workId);
    if (!queued) return false;
    this.failed.delete(workId);
    this.queue.push(queued);
    this.pump();
    return true;
  }

  /** Cancels the pending retries (server shutdown). */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * A failed item is tried again, nothing having been published: after the reset time of a subscription
   * limit (not counted as an attempt), else after the next delay of the ladder; past the ladder it fails for good.
   */
  private fail(workId: string, message: string): void {
    const held = this.active.get(workId);
    this.release(workId);
    if (!held) return;
    const { queued } = held;
    const limit = isSubscriptionLimit(message);
    const attempt = this.attempts.get(workId) ?? 0;
    let delayMs: number | undefined;
    if (limit) {
      const resetAt = limitResetAt(message);
      delayMs = resetAt === undefined ? UNKNOWN_RESET_WAIT_MS : Math.max(0, resetAt - Date.now());
    } else {
      delayMs = this.retryDelaysMs[attempt];
      this.attempts.set(workId, attempt + 1);
    }
    if (delayMs === undefined) {
      this.attempts.delete(workId);
      this.failed.set(workId, queued);
      return;
    }
    const { item } = queued;
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.store.emit({ type: "work-retrying", pageId: item.pageId, workId, threadIds: item.threads.map((t) => t.threadId), retryAt, limit, message });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.queue = [queued, ...this.queue];
      this.pump();
    }, delayMs);
    timer.unref();
    this.timers.add(timer);
  }

  /** Items of a page still waiting for their turn, oldest first, each with the reason it waits. */
  waiting(pageId: string): QueueEntry[] {
    return this.reasons().flatMap(({ queued, reason }) =>
      queued.item.pageId === pageId
        ? [{ workId: queued.item.id, pageId, threadIds: queued.item.threads.map((t) => t.threadId), reason }]
        : [],
    );
  }

  private isPageLocked(pageId: string): boolean {
    for (const held of this.active.values()) if (held.queued.item.pageId === pageId) return true;
    return false;
  }

  /** Why each queued item waits: an item behind an earlier item of its page shares that item's reason. */
  private reasons(): { queued: Queued; reason: QueueReason }[] {
    const reasonOfPage = new Map<string, QueueReason>();
    return this.queue.map((queued) => {
      const { pageId } = queued.item;
      let reason = reasonOfPage.get(pageId);
      if (!reason) {
        reason = this.isPageLocked(pageId) ? "page-busy" : "agent-offline";
        reasonOfPage.set(pageId, reason);
      }
      return { queued, reason };
    });
  }

  private pump(): void {
    const touched = new Set(this.queue.map((q) => q.item.pageId));
    const blockedPages = new Set<string>();
    const stillWaiting: Queued[] = [];
    for (const queued of this.queue) {
      const { pageId } = queued.item;
      const target = this.pickTarget(queued);
      if (blockedPages.has(pageId) || this.isPageLocked(pageId) || !target) {
        blockedPages.add(pageId);
        stillWaiting.push(queued);
        continue;
      }
      const { agentId, item } = target;
      this.active.set(queued.item.id, { queued, agentId });
      if (this.hub.send(agentId, { type: "work", item })) {
        queued.onDispatched?.(agentId, item);
        this.store.emit({ type: "work-dispatched", pageId, workId: item.id, threadIds: item.threads.map((t) => t.threadId) });
        continue;
      }
      this.active.delete(queued.item.id);
      blockedPages.add(pageId);
      stillWaiting.push(queued);
    }
    this.queue = stillWaiting;
    for (const pageId of touched) this.store.emit({ type: "queue-updated", pageId });
  }

  /** Re-checks the queue after something other than the lock changed which agent may run an item (a project's takeover setting). */
  reconsider(): void {
    this.pump();
  }

  /**
   * The single place agents are chosen. A pinned item goes to its agent, or, when that agent is offline and the project
   * allows the takeover, to the global agent as its `takeoverItem` (a new session). Other items go to `chooseAgent`.
   */
  private pickTarget(queued: Queued): { agentId: string; item: WorkItem } | undefined {
    if (queued.agentId) {
      if (this.store.getAgent(queued.agentId)?.status === "online") return { agentId: queued.agentId, item: queued.item };
      const globalId = this.store.getProject(queued.projectId)?.allowGlobalTakeover ? this.store.findOnlineGlobalAgentId() : undefined;
      return globalId && queued.takeoverItem ? { agentId: globalId, item: queued.takeoverItem } : undefined;
    }
    const choice = chooseAgent(this.store, queued.projectId);
    return choice && { agentId: choice.agentId, item: queued.item };
  }

  /** The agent running an item went away: nothing was published, so the item goes back to the front of the queue. */
  private requeueActiveOf(agentId: string): void {
    const lost = [...this.active.values()].filter((held) => held.agentId === agentId);
    for (const held of lost) this.active.delete(held.queued.item.id);
    this.queue = [...lost.map((held) => held.queued), ...this.queue];
    this.pump();
  }
}
