import { randomUUID } from "node:crypto";
import type { Person, QueueEntry, QueueReason, WorkItem, WorkLabels } from "@redline/shared";
import { chooseAgent } from "./agent-selection.js";
import type { AgentHub } from "./agents.js";
import { RETRY_DELAYS_MS, UNKNOWN_RESET_WAIT_MS, isSubscriptionLimit, limitResetAt } from "./retry-policy.js";
import type { PersistedWork, Store } from "./store.js";

export interface SubmitOptions {
  projectId: string;
  /** Only this agent may run the item (a resumed session lives on the agent that opened it). Default: the project's online agent. */
  agentId?: string;
  /**
   * What to send instead (a fresh session, told the conversation so far) when the pinned agent is not available:
   * offline with the global agent taking over, or no longer the project's agent. Without it a pinned item just waits.
   */
  takeoverItem?: WorkItem;
  /**
   * The item waits for the terminal session that holds its page instead of going to an agent, until `releaseTerminalWork`.
   * Only for new work no agent session owns.
   */
  forTerminal?: boolean;
  /** The person who handed the item over to the agent from a held page: the run works for them instead of the commenter. */
  handedOverBy?: Person;
}

interface Queued extends SubmitOptions {
  item: WorkItem;
  /** Server-side holder (terminal mode): called instead of sending to an agent when the page is granted. Never persisted. */
  onGranted?(): void;
}

interface Active {
  queued: Queued;
  agentId: string;
  /** Who the run works for, fixed when the item is sent: the author of the message that starts it, not of a later reply. */
  requester?: Person;
}

interface Retrying {
  queued: Queued;
  timer: ReturnType<typeof setTimeout>;
  retryAt: string;
  limit: boolean;
  message: string;
}

/**
 * The single dispatch path for work items. The server grants at most one active work item per page
 * (threads, conversations and terminal mode alike); other items wait in submission order, and
 * items of different pages run in parallel. An item also waits while no agent can run it; such an item
 * does not hold back items of its page that another agent can run (apart from items of its own session).
 *
 * The queue, the item running on an agent, the retry schedule and the items that failed for good are
 * mirrored in the database; `restore()` brings them back after a restart (a running item goes back to the head of its page's queue).
 */
export class PageLock {
  private queue: Queued[] = [];
  private readonly active = new Map<string, Active>();
  /** Failed items waiting for their next try; they do not hold the page meanwhile. */
  private readonly retrying = new Map<string, Retrying>();
  private readonly attempts = new Map<string, number>();
  /** Items that failed for good, kept so "Relancer" can put them back in the queue. */
  private readonly failed = new Map<string, { queued: Queued; message: string }>();

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
    hub.acceptWorkMessagesFrom((agentId, workId) => this.active.get(workId)?.agentId === agentId);
  }

  /** Loads the persisted state. Call once, after every listener of the store events is registered (the run tracker needs the replayed events). */
  restore(): void {
    const rows = this.store.loadWorkQueue();
    const toQueued = ({ projectId, agentId, item, takeoverItem, forTerminal, handedOverBy }: PersistedWork): Queued => ({
      projectId,
      agentId,
      item,
      takeoverItem,
      ...(forTerminal ? { forTerminal } : {}),
      ...(handedOverBy ? { handedOverBy } : {}),
    });
    this.queue = [...rows.filter((r) => r.state === "active"), ...rows.filter((r) => r.state === "queued")].map(toQueued);
    for (const row of rows) {
      if (row.attempts > 0) this.attempts.set(row.item.id, row.attempts);
      const { item } = row;
      const threadIds = item.threads.map((t) => t.threadId);
      if (row.state === "retrying") {
        this.store.emit({ type: "work-dispatched", pageId: item.pageId, workId: item.id, threadIds });
        const retryAt = row.retryAt ?? new Date().toISOString();
        const message = row.message ?? "";
        this.store.emit({ type: "work-retrying", pageId: item.pageId, workId: item.id, threadIds, retryAt, limit: row.limit ?? false, message });
        this.scheduleRetry(toQueued(row), Math.max(0, Date.parse(retryAt) - Date.now()), retryAt, row.limit ?? false, message);
      } else if (row.state === "failed") {
        this.failed.set(item.id, { queued: toQueued(row), message: row.message ?? "" });
        this.store.emit({ type: "work-dispatched", pageId: item.pageId, workId: item.id, threadIds });
        this.store.emit({ type: "work", message: { type: "work-failed", workId: item.id, message: row.message ?? "" } });
      }
    }
    this.pump();
  }

  /** Queues a work item for its page; it is sent to the project's agent (or `options.agentId`) as soon as the page is free and that agent is online. */
  submit(options: SubmitOptions, item: WorkItem): void {
    this.queue.push({ ...options, item });
    this.pump();
  }

  /** Sends the waiting work `only` accepts to the agents, under the single routing rule (its terminal session left, or its page was handed over). */
  releaseTerminalWork(only: (item: WorkItem) => boolean, handedOverBy?: Person): void {
    let released = false;
    for (const queued of this.queue) {
      if (!queued.forTerminal || !only(queued.item)) continue;
      this.sendToAgents(queued, handedOverBy);
      released = true;
    }
    if (released) this.pump();
  }

  /** The item stops waiting for a terminal session. A reply that waited in a thread the terminal session started gets the thread's history: the agent has no session to resume. */
  private sendToAgents(queued: Queued, handedOverBy?: Person): void {
    delete queued.forTerminal;
    if (handedOverBy) queued.handedOverBy = handedOverBy;
    if (!queued.takeoverItem || queued.agentId) return;
    queued.item = { ...queued.takeoverItem, id: queued.item.id };
    delete queued.takeoverItem;
  }

  /**
   * Sends the waiting work of one thread to the agents. A batch holding other threads is split: `split` gives the item
   * for the thread and the item for the others. False when no item waiting for a terminal session holds the thread.
   */
  releaseTerminalThread(threadId: string, split: (item: WorkItem) => { handed: WorkItem; rest: WorkItem }, handedOverBy?: Person): boolean {
    const index = this.queue.findIndex((q) => q.forTerminal && q.item.threads.some((t) => t.threadId === threadId));
    if (index < 0) return false;
    const queued = this.queue[index];
    if (queued.item.threads.length > 1) {
      const { handed, rest } = split(queued.item);
      queued.item = rest;
      this.queue.splice(index + 1, 0, { projectId: queued.projectId, item: handed, ...(handedOverBy ? { handedOverBy } : {}) });
    } else {
      this.sendToAgents(queued, handedOverBy);
    }
    this.pump();
    this.save();
    this.store.emit({ type: "queue-updated", pageId: queued.item.pageId });
    return true;
  }

  /** The comments waiting for a terminal session, per page. */
  terminalWaiting(): { pageId: string; threadIds: string[] }[] {
    return this.queue.filter((q) => q.forTerminal).map((q) => ({ pageId: q.item.pageId, threadIds: q.item.threads.map((t) => t.threadId) }));
  }

  /**
   * Hands the waiting items `match` accepts to a terminal session: they leave the queue without being sent, and each of their
   * threads gets a run of its own showing it as being worked on (so that answering one thread does not end the others of a batch).
   */
  takeTerminalWork(match: (item: WorkItem) => boolean): { item: WorkItem; runs: { threadId: string; workId: string }[] }[] {
    const taken = this.queue.filter((q) => q.forTerminal && match(q.item));
    if (taken.length === 0) return [];
    this.queue = this.queue.filter((q) => !taken.includes(q));
    this.save();
    for (const pageId of new Set(taken.map((q) => q.item.pageId))) this.store.emit({ type: "queue-updated", pageId });
    return taken.map(({ item }) => ({
      item,
      runs: item.threads.map(({ threadId }) => {
        const workId = randomUUID();
        this.showTerminalRun(item.pageId, workId, threadId);
        return { threadId, workId };
      }),
    }));
  }

  /** Shows a thread as being worked on by a terminal session (a picked thread, or one picked before a restart). */
  showTerminalRun(pageId: string, workId: string, threadId: string): void {
    this.store.emit({ type: "work-dispatched", pageId, workId, threadIds: [threadId] });
  }

  /** Ends the run of a thread picked by a terminal session: done (the session answered) or failed (the thread goes back to the agents). */
  endTerminalRun(workId: string, failure?: string): void {
    this.store.emit({ type: "work", message: failure === undefined ? { type: "work-done", workId } : { type: "work-failed", workId, message: failure } });
  }

  /** Waits for the page's turn like any work item (no agent needed); resolves with the function that releases the page. */
  acquire(pageId: string): Promise<() => void> {
    return new Promise((resolve) => {
      const item: WorkItem = { id: randomUUID(), kind: "thread", pageId, threads: [], message: "", sessionId: "", resume: false };
      this.queue.push({ projectId: "", item, onGranted: () => resolve(() => this.release(item.id)) });
      this.pump();
    });
  }

  /** A work item that is queued, running, waiting for a retry or failed for good. */
  itemOf(workId: string): WorkItem | undefined {
    return (
      this.queue.find((q) => q.item.id === workId)?.item ??
      this.active.get(workId)?.queued.item ??
      this.retrying.get(workId)?.queued.item ??
      this.failed.get(workId)?.queued.item
    );
  }

  /** The person a running item works for (none without SSO, for comments from before the SSO, or for terminal mode). */
  requesterOf(workId: string): Person | undefined {
    return this.active.get(workId)?.requester;
  }

  /**
   * Rewrites the first item not yet sent (queued, or waiting for a retry) that `match` accepts; an item already sent cannot change.
   * False when none matches. Used to merge messages that leave together.
   */
  amendQueued(match: (item: WorkItem) => boolean, amend: (item: WorkItem) => WorkItem): boolean {
    const queued = this.queue.find((q) => match(q.item)) ?? [...this.retrying.values()].find((r) => match(r.queued.item))?.queued;
    if (!queued) return false;
    queued.item = amend(queued.item);
    if (queued.takeoverItem) queued.takeoverItem = amend(queued.takeoverItem);
    this.save();
    this.store.emit({ type: "queue-updated", pageId: queued.item.pageId });
    return true;
  }

  /** Frees the page held by a finished work item (done or failed) and starts the next one. Unknown ids are ignored. */
  release(workId: string): void {
    if (!this.active.delete(workId)) return;
    this.pump();
  }

  /** Puts an item that failed for good back in the queue of its page. False when `workId` is not such an item. */
  retry(workId: string): boolean {
    const held = this.failed.get(workId);
    if (!held) return false;
    this.failed.delete(workId);
    this.queue.push(withFreshSession(held.queued));
    this.pump();
    return true;
  }

  /** Cancels the pending retries (server shutdown). */
  dispose(): void {
    for (const { timer } of this.retrying.values()) clearTimeout(timer);
  }

  /**
   * A failed item is tried again, nothing having been published: after the reset time of a subscription
   * limit (not counted as an attempt), else after the next delay of the ladder; past the ladder it fails for good.
   */
  private fail(workId: string, message: string): void {
    const held = this.active.get(workId);
    this.active.delete(workId);
    if (held) this.scheduleAfterFailure(held.queued, message);
    this.pump();
  }

  private scheduleAfterFailure(queued: Queued, message: string): void {
    const workId = queued.item.id;
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
      this.failed.set(workId, { queued, message });
      return;
    }
    const { item } = queued;
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.store.emit({ type: "work-retrying", pageId: item.pageId, workId, threadIds: item.threads.map((t) => t.threadId), retryAt, limit, message });
    this.scheduleRetry(queued, delayMs, retryAt, limit, message);
  }

  private scheduleRetry(queued: Queued, delayMs: number, retryAt: string, limit: boolean, message: string): void {
    const workId = queued.item.id;
    const timer = setTimeout(() => {
      this.retrying.delete(workId);
      this.queue = [withFreshSession(queued), ...this.queue];
      this.pump();
    }, delayMs);
    timer.unref();
    this.retrying.set(workId, { queued, timer, retryAt, limit, message });
  }

  /** Items of a page still waiting for their turn, oldest first, each with the reason it waits. */
  waiting(pageId: string): QueueEntry[] {
    return this.reasons().flatMap(({ queued, reason }) =>
      queued.item.pageId === pageId
        ? [{ workId: queued.item.id, pageId, threadIds: queued.item.threads.map((t) => t.threadId), reason }]
        : [],
    );
  }

  /** Every item running on an agent and every item waiting, across pages (home screen and sidebar). */
  overview(): { running: { workId: string; pageId: string; agentId: string; threadIds: string[] }[]; waiting: (QueueEntry & { projectId: string })[] } {
    const running = [...this.active.values()]
      .filter((held) => held.agentId !== "")
      .map((held) => ({
        workId: held.queued.item.id,
        pageId: held.queued.item.pageId,
        agentId: held.agentId,
        threadIds: held.queued.item.threads.map((t) => t.threadId),
      }));
    const waiting = this.reasons().map(({ queued, reason }) => ({
      workId: queued.item.id,
      pageId: queued.item.pageId,
      projectId: queued.projectId,
      threadIds: queued.item.threads.map((t) => t.threadId),
      reason,
    }));
    return { running, waiting };
  }

  /** Whether a work item runs or will be retried on one of `pageIds` (archiving a project waits for none). Waiting and failed items do not count. */
  hasWorkOn(pageIds: Set<string>): boolean {
    const items = [...[...this.active.values()].map((held) => held.queued), ...[...this.retrying.values()].map((r) => r.queued)];
    return items.some((queued) => pageIds.has(queued.item.pageId));
  }

  /** Forgets the waiting and failed items of deleted pages, so they are neither sent, persisted nor offered to "Relancer". */
  forgetPages(pageIds: Set<string>): void {
    // A terminal publish waiting for the page (`onGranted`) stays: once granted, the route finds the page gone and answers.
    this.queue = this.queue.filter((queued) => queued.onGranted !== undefined || !pageIds.has(queued.item.pageId));
    for (const [workId, failed] of this.failed) if (pageIds.has(failed.queued.item.pageId)) this.failed.delete(workId);
    this.save();
  }

  /** Whether a work item other than `exceptWorkId` is running on the page (a session, or terminal mode publishing). */
  isHeldByOther(pageId: string, exceptWorkId?: string): boolean {
    for (const [workId, held] of this.active) if (held.queued.item.pageId === pageId && workId !== exceptWorkId) return true;
    return false;
  }

  private isPageLocked(pageId: string): boolean {
    for (const held of this.active.values()) if (held.queued.item.pageId === pageId) return true;
    return false;
  }

  /** Why each queued item waits: the page is busy with another item, or no agent can run it. */
  private reasons(): { queued: Queued; reason: QueueReason }[] {
    return this.queue.map((queued) => ({
      queued,
      reason: queued.forTerminal
        ? "terminal"
        : this.isArchivedProjectPage(queued.item.pageId)
        ? "project-archived"
        : this.store.isPageArchived(queued.item.pageId)
          ? "page-archived"
          : this.isPageLocked(queued.item.pageId)
            ? "page-busy"
            : "agent-offline",
    }));
  }

  private isArchivedProjectPage(pageId: string): boolean {
    const projectId = this.store.projectIdOfPage(pageId);
    return projectId !== undefined && this.store.isArchived(projectId);
  }

  /** The page, or its project, is archived: its waiting items stay queued until it is unarchived. */
  private isArchivedPage(pageId: string): boolean {
    return this.store.isPageArchived(pageId) || this.isArchivedProjectPage(pageId);
  }

  private pump(): void {
    const touched = new Set(this.queue.map((q) => q.item.pageId));
    // Sessions that have an item still waiting: a later item of the same session must not overtake it.
    const waitingSessions = new Set<string>();
    const stillWaiting: Queued[] = [];
    for (const queued of this.queue) {
      const { pageId, sessionId } = queued.item;
      if (queued.forTerminal) {
        stillWaiting.push(queued);
        continue;
      }
      // An archived project's or page's waiting items stay queued until it is unarchived (`reconsider`); a terminal publish
      // waiting for the page (`onGranted`) is granted, so that the archive guard refuses its write and the call is answered.
      if (this.isPageLocked(pageId) || (sessionId !== "" && waitingSessions.has(sessionId)) || (this.isArchivedPage(pageId) && !queued.onGranted)) {
        stillWaiting.push(queued);
        continue;
      }
      if (queued.onGranted) {
        this.active.set(queued.item.id, { queued, agentId: "" });
        queued.onGranted();
        continue;
      }
      const target = this.pickTarget(queued);
      if (!target) {
        waitingSessions.add(sessionId);
        stillWaiting.push(queued);
        continue;
      }
      const { agentId, item } = target;
      const requester = queued.handedOverBy ?? this.store.requestingPersonOfItem(item);
      this.active.set(queued.item.id, { queued, agentId, requester });
      if (this.hub.send(agentId, { type: "work", item: { ...item, labels: this.labelsOf(item, requester) } })) {
        this.recordSession(agentId, item);
        this.store.emit({ type: "work-dispatched", pageId, workId: item.id, threadIds: item.threads.map((t) => t.threadId) });
        continue;
      }
      this.active.delete(queued.item.id);
      waitingSessions.add(sessionId);
      stillWaiting.push(queued);
    }
    this.queue = stillWaiting;
    this.save();
    for (const pageId of touched) this.store.emit({ type: "queue-updated", pageId });
  }

  private labelsOf(item: WorkItem, requester: Person | undefined): WorkLabels {
    const page = this.store.getPage(item.pageId);
    const projectId = page?.projectId ?? "";
    const author = requester && (requester.name || requester.email);
    return {
      project: this.store.getProject(projectId)?.title ?? this.store.getDesignSystem(projectId)?.title ?? "",
      page: page?.title ?? "",
      ...(author ? { author } : {}),
    };
  }

  /** The sent item's session now belongs to the agent that got it: threads and conversations resume it there. */
  private recordSession(agentId: string, sent: WorkItem): void {
    for (const { threadId } of sent.threads) {
      this.store.setThreadSession(threadId, sent.sessionId, agentId);
      if (!sent.resume && this.store.getThread(threadId)?.newSession === "ready") this.store.setNewSession(threadId, null);
    }
    if (sent.conversationId) this.store.setConversationSession(sent.conversationId, sent.sessionId, agentId);
  }

  /** Re-checks the queue after something other than the lock changed which agent may run an item (a project's takeover setting). */
  reconsider(): void {
    this.pump();
  }

  /**
   * The single place agents are chosen. A pinned item goes to its agent while that agent is online. Otherwise, with a
   * `takeoverItem` (a new session): to the project's current agent when the pinned one was replaced (or is a global agent),
   * or to the global agent when the pinned one is still a project agent, offline, and the project allows the takeover.
   * Other items go to `chooseAgent`.
   */
  private pickTarget(queued: Queued): { agentId: string; item: WorkItem } | undefined {
    const { agentId: pinned, takeoverItem, projectId } = queued;
    const designSystem = this.store.isDesignSystemProject(projectId);
    // Only a design system's work depends on the project it was opened from.
    const choose = () => chooseAgent(this.store, projectId, designSystem ? this.store.viaProjectOfItem(queued.item) : undefined);
    if (!pinned) {
      const choice = choose();
      return choice && { agentId: choice.agentId, item: queued.item };
    }
    if (this.store.getAgent(pinned)?.status === "online") return { agentId: pinned, item: queued.item };
    if (!takeoverItem) return undefined;
    // Whatever is sent keeps the queued item's id: the lock and the agent's reports are keyed by it.
    const taken = { ...takeoverItem, id: queued.item.id };
    // A design system's work is never pinned to an agent of its own: the next agent its rule picks starts a new session.
    if (!this.store.isProjectAgent(pinned) || designSystem) {
      const choice = choose();
      return choice && { agentId: choice.agentId, item: taken };
    }
    const globalId = this.store.getProject(projectId)?.globalTakeover ? this.store.findOnlineGlobalAgentId() : undefined;
    return globalId ? { agentId: globalId, item: taken } : undefined;
  }

  /** The agent running an item went away: nothing was published, so the item goes back to the front of the queue (in a fresh session if it started one). */
  private requeueActiveOf(agentId: string): void {
    const lost = [...this.active.values()].filter((held) => held.agentId === agentId);
    for (const held of lost) this.active.delete(held.queued.item.id);
    this.queue = [...lost.map((held) => withFreshSession(held.queued)), ...this.queue];
    this.pump();
  }

  private save(): void {
    const entry = (state: PersistedWork["state"], queued: Queued, extra: Partial<PersistedWork> = {}): PersistedWork => ({
      state,
      projectId: queued.projectId,
      agentId: queued.agentId,
      item: queued.item,
      takeoverItem: queued.takeoverItem,
      ...(queued.forTerminal ? { forTerminal: true } : {}),
      ...(queued.handedOverBy ? { handedOverBy: queued.handedOverBy } : {}),
      attempts: this.attempts.get(queued.item.id) ?? 0,
      ...extra,
    });
    const rows: PersistedWork[] = [
      ...[...this.active.values()].filter((h) => !h.queued.onGranted && h.agentId !== "").map((h) => entry("active", h.queued)),
      ...this.queue.filter((q) => !q.onGranted).map((q) => entry("queued", q)),
      ...[...this.retrying.values()].map((r) => entry("retrying", r.queued, { retryAt: r.retryAt, limit: r.limit, message: r.message })),
      ...[...this.failed.values()].map((f) => entry("failed", f.queued, { message: f.message })),
    ];
    this.store.saveWorkQueue(rows);
  }
}

/**
 * A resent item that opened its session (`resume: false`) may have created it before failing, and `--session-id` of an
 * existing session is refused: it starts again under a new id. A resumed item keeps its session.
 */
function withFreshSession(queued: Queued): Queued {
  const fresh = (item: WorkItem): WorkItem => (item.resume ? item : { ...item, sessionId: randomUUID() });
  return { ...queued, item: fresh(queued.item), ...(queued.takeoverItem ? { takeoverItem: fresh(queued.takeoverItem) } : {}) };
}
