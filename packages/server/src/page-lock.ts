import type { QueueEntry, QueueReason, WorkItem } from "@redline/shared";
import { chooseAgent } from "./agent-selection.js";
import type { AgentHub } from "./agents.js";
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

  constructor(
    private readonly store: Store,
    private readonly hub: AgentHub,
  ) {
    store.onChange((event) => {
      if (event.type === "work" && (event.message.type === "work-done" || event.message.type === "work-failed")) {
        this.release(event.message.workId);
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
