import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import type { AgentHub } from "../src/agents.js";
import { PageLock } from "../src/page-lock.js";
import { Store } from "../src/store.js";
import { takeThreads } from "../src/comment-takes.js";
import { dispatchBatch, handOverThread } from "../src/work.js";

const FILES = { "home.html": "<h1>Home</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };
/** A hub with no agent online: everything queued waits for an offline agent. */
const OFFLINE_HUB = { onAgentOnline() {}, onAgentOffline() {}, acceptWorkMessagesFrom() {}, send: () => false } as unknown as AgentHub;

describe("threads waiting in the queue for an offline agent", () => {
  let dataDir: string;
  let store: Store;
  let lock: PageLock;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-waiting-"));
    store = new Store(dataDir);
    lock = new PageLock(store, OFFLINE_HUB);
  });
  afterEach(() => {
    lock.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function pageWithThreads(count: number): { projectId: string; pageId: string; threads: Thread[] } {
    const project = store.createProject("Acme");
    const page = store.createPage(project.id, "Home", FILES);
    store.setCommentMode(page.id, "agent");
    const threads = Array.from({ length: count }, (_, i) => store.createThread(page.id, { target: { kind: "artboard", artboard: "home.html" }, body: `Comment ${i + 1}` }));
    return { projectId: project.id, pageId: page.id, threads };
  }

  it("can be taken one by one out of a batch, the others keep waiting together", () => {
    const { projectId, pageId, threads } = pageWithThreads(3);
    dispatchBatch(store, lock, projectId, threads);

    expect(threads.map((t) => lock.isWaitingForAgent(t.id))).toEqual([true, true, true]);
    expect(lock.withdrawWaiting(threads[1].id)).toBe(true);

    expect(lock.waiting(pageId).map((entry) => entry.threadIds)).toEqual([[threads[0].id, threads[2].id]]);
    expect(lock.isWaitingForAgent(threads[1].id)).toBe(false);
    expect(lock.hasWorkFor(threads[1].id)).toBe(false);
    expect(lock.withdrawWaiting(threads[0].id)).toBe(true);
    expect(lock.withdrawWaiting(threads[2].id)).toBe(true);
    expect(lock.waiting(pageId)).toEqual([]);
  });

  it("is not taken when it was handed over to the agent", () => {
    const { projectId, pageId, threads } = pageWithThreads(1);
    handOverThread(lock, projectId, threads[0], { id: "p1", name: "Ariane", email: "a@example.com", initials: "A" });

    expect(lock.isWaitingForAgent(threads[0].id)).toBe(false);
    expect(lock.withdrawWaiting(threads[0].id)).toBe(false);
    expect(lock.waiting(pageId)).toHaveLength(1);
  });

  it("does not stop a takeover when the agent's run of the thread failed, and forgets that run", () => {
    const { projectId, pageId, threads } = pageWithThreads(1);
    const [thread] = threads;
    store.takeThread(thread.id, { accountId: "ana", folder: "~/crm", machine: "m" });
    const item = { id: "work-1", kind: "thread" as const, pageId, threads: [{ threadId: thread.id, number: 1, artboard: "home.html", selector: "", xPct: 0, yPct: 0, body: "x" }], message: "x", sessionId: "s1", resume: false };
    store.saveWorkQueue([{ state: "failed", projectId, item, attempts: 0, message: "boom" }]);
    lock.restore();
    expect(lock.hasWorkFor(thread.id)).toBe(true);
    const env = { store, pageLock: lock, levelOf: () => "write" as const };

    const answer = takeThreads(env, { accountId: "tom", folder: "~/site", machine: "m" }, [thread.id], true);

    expect(answer.refused).toEqual([]);
    expect(answer.comments).toEqual([expect.objectContaining({ threadId: thread.id, state: "taken-over" })]);
    expect(lock.hasWorkFor(thread.id)).toBe(false);
  });
});
