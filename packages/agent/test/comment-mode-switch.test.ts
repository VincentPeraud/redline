import { afterEach, describe, expect, it } from "vitest";
import type { CommentMode, QueueEntry, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const queueOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/queue`)).json()) as QueueEntry[];
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
const threadOf = async (pageId: string, id: string) => (await threadsOf(pageId)).find((t) => t.id === id)!;
const switchTo = async (pageId: string, mode: CommentMode) => {
  const response = await seam!.server.post(`/api/pages/${pageId}/comment-mode`, { mode });
  return { status: response.status, body: (await response.json()) as { movedThreads: number } };
};

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

async function waitUntilOffline(s: Seam2): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const agents = (await (await s.server.get("/api/agents")).json()) as { status: string }[];
    if (agents.every((a) => a.status === "offline")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("agent still online");
}

async function conversationPage(engine = answeringEngine()) {
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
  return { engine, page };
}

describe("switching a page to Agent mode", () => {
  it("sends the threads to take to the agent and tells how many left", async () => {
    const { engine, page } = await conversationPage();
    const first = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const second = await seam!.pinThread(page.id, "home.html", "Bigger title");
    expect(engine.runs).toHaveLength(0);

    const result = await switchTo(page.id, "agent");

    expect(result).toMatchObject({ status: 200, body: { movedThreads: 2 } });
    await seam!.waitForWorkEnd(1);
    expect(engine.runs.length).toBeGreaterThan(0);
    for (const id of [first.id, second.id]) expect(await threadOf(page.id, id)).not.toHaveProperty("toTake");
  });

  it("leaves a thread taken by an account with its taker", async () => {
    const { engine, page } = await conversationPage();
    const taken = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });

    const result = await switchTo(page.id, "agent");

    expect(result.body.movedThreads).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.runs).toHaveLength(0);
    expect(await threadOf(page.id, taken.id)).toMatchObject({ take: { machine: "MacBook-Pro" } });
  });

  it("makes the threads wait for the offline agent, visibly and without being to take", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    seam!.agent.close();
    await waitUntilOffline(seam!);

    await switchTo(page.id, "agent");

    expect(await queueOf(page.id)).toMatchObject([{ reason: "agent-offline", threadIds: [thread.id] }]);
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("toTake");
  });
});

describe("switching a page back to Conversation mode", () => {
  it("turns the threads waiting for the offline agent back to take", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    seam!.agent.close();
    await waitUntilOffline(seam!);
    await switchTo(page.id, "agent");

    const result = await switchTo(page.id, "conversation");

    expect(result.body.movedThreads).toBe(1);
    expect(await queueOf(page.id)).toEqual([]);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ toTake: true });
  });

  it("leaves a thread an agent started with the agent", async () => {
    const { engine, page } = await conversationPage();
    await switchTo(page.id, "agent");
    const started = await seam!.pinThread(page.id, "home.html", "Make it blue");
    await seam!.waitForWorkEnd(1);

    const result = await switchTo(page.id, "conversation");

    expect(result.body.movedThreads).toBe(0);
    expect(engine.runs).toHaveLength(1);
    expect(await threadOf(page.id, started.id)).not.toHaveProperty("toTake");
  });

  it("changes nothing when the page already is in that mode", async () => {
    const { page } = await conversationPage();
    await seam!.pinThread(page.id, "home.html", "Make it blue");

    expect((await switchTo(page.id, "conversation")).body.movedThreads).toBe(0);
    expect((await threadsOf(page.id))[0]).toMatchObject({ toTake: true });
  });
});

describe("pending_comments { pageId } with an offline agent", () => {
  it("takes the threads waiting for the offline agent, which then leave its queue", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    seam!.agent.close();
    await waitUntilOffline(seam!);
    await switchTo(page.id, "agent");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");

    const answer = await terminal.call("pending_comments", { pageId: page.id });

    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(await queueOf(page.id)).toEqual([]);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ take: { machine: "MacBook-Pro" } });
    expect(engine.runs).toHaveLength(0);
  });
});
