import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
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

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

const threadOf = async (pageId: string, id: string) => ((await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[]).find((t) => t.id === id)!;
const handOver = (threadId: string, body: object = {}) => seam!.server.post(`/api/threads/${threadId}/hand-over`, body);
const release = (threadId: string) => seam!.server.post(`/api/threads/${threadId}/release`, {});

async function conversationPage() {
  const engine = answeringEngine();
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
  return { engine, page };
}

async function waitUntilOffline(s: Seam2): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const agents = (await (await s.server.get("/api/agents")).json()) as { status: string }[];
    if (agents.every((a) => a.status === "offline")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("agent still online");
}

describe("Confier à l'agent", () => {
  it("sends a thread to take to the agent without changing the page's mode", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    expect(engine.runs).toHaveLength(0);

    const response = await handOver(thread.id);

    expect(response.status).toBe(200);
    await seam!.waitForWorkEnd(1);
    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].message).toContain(`thread id: ${thread.id}`);
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("toTake");
    const pageNow = (await (await seam!.server.get(`/api/pages/${page.id}`)).json()) as { commentMode: string };
    expect(pageNow.commentMode).toBe("conversation");
  });

  it("keeps the later replies of the thread with the agent", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    await handOver(thread.id);
    await seam!.waitForWorkEnd(1);

    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Darker please" });

    await seam!.waitForWorkEnd(2);
    expect(engine.runs).toHaveLength(2);
    expect(engine.runs[1].message).toContain("Darker please");
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("toTake");
  });

  it("takes a thread of its own account away from its conversation without asking", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });

    const response = await handOver(thread.id);

    expect(response.status).toBe(200);
    await seam!.waitForWorkEnd(1);
    const after = await threadOf(page.id, thread.id);
    expect(after).not.toHaveProperty("take");
    expect(after).not.toHaveProperty("toTake");
    expect(engine.runs).toHaveLength(1);
  });

  it("is refused with the reason when no agent runs for the project", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    seam!.agent.close();
    await waitUntilOffline(seam!);

    const response = await handOver(thread.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "no-agent", error: "Aucun agent ne tourne : lance-en un depuis la page Agents" });
    expect(engine.runs).toHaveLength(0);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ toTake: true });
  });

  it("is refused for a thread the agent already owns", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    await handOver(thread.id);
    await seam!.waitForWorkEnd(1);

    const response = await handOver(thread.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "already-agent" });
  });

  it("is refused for a resolved thread", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    await seam!.server.post(`/api/threads/${thread.id}/resolve`, {});

    const response = await handOver(thread.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "not-open" });
  });
});

describe("Libérer", () => {
  it("gives a thread taken by the account back to take in Conversation mode", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });

    const response = await release(thread.id);

    expect(response.status).toBe(200);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ toTake: true });
  });

  it("sends the released thread to the agent in Agent mode", async () => {
    const { engine, page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");
    const terminal = await openTerminal(seam!, stops, "MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });
    await seam!.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "agent" });
    expect(engine.runs).toHaveLength(0);

    await release(thread.id);

    await seam!.waitForWorkEnd(1);
    expect(engine.runs).toHaveLength(1);
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("take");
  });

  it("is refused on a thread nobody took", async () => {
    const { page } = await conversationPage();
    const thread = await seam!.pinThread(page.id, "home.html", "Make it blue");

    expect((await release(thread.id)).status).toBe(409);
  });
});
