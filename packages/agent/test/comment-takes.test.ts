import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { CommentMode, Page, QueueEntry, ServerEvent, Thread } from "@redline/shared";
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

const open = (machine: string, options: { folder?: string } = {}) => openTerminal(seam!, stops, machine, options);

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const queueOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/queue`)).json()) as QueueEntry[];
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
const threadOf = async (pageId: string, id: string) => (await threadsOf(pageId)).find((t) => t.id === id)!;
const pageOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}`)).json()) as Page;

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

/** A page in Conversation mode (the production default) with one thread posted on it. */
async function threadToTake(body = "Make it blue", mode?: CommentMode) {
  const engine = answeringEngine();
  seam = await startSeam2(engine);
  const page = await seam.createPage(PAGE_FILES, "Accueil", mode ?? "conversation");
  const thread = await seam.pinThread(page.id, "home.html", body);
  return { engine, page, thread };
}

describe("a new thread in Conversation mode is to take", () => {
  it("is sent to nobody: no agent run, nothing queued, the thread shows as to take", async () => {
    const { engine, page, thread } = await threadToTake();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(engine.runs).toHaveLength(0);
    expect(await queueOf(page.id)).toEqual([]);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ toTake: true });
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("take");
  });

  it("goes to the agent when the page is in Agent mode", async () => {
    const { engine, page, thread } = await threadToTake("Make it blue", "agent");
    await seam!.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("toTake");
  });

  it("starts every page in Conversation mode and switches it", async () => {
    const { page } = await threadToTake();
    expect((await pageOf(page.id)).commentMode).toBe("conversation");

    expect((await seam!.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "agent" })).status).toBe(200);
    expect((await pageOf(page.id)).commentMode).toBe("agent");
    expect((await seam!.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "nobody" })).status).toBe(400);
    expect(seam!.events().some((e: ServerEvent) => e.type === "comment-mode-changed" && e.pageId === page.id && e.mode === "agent")).toBe(true);
  });
});

describe("pending_comments takes a page's threads for the account", () => {
  it("says so when nothing is to take", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
    const terminal = await open("MacBook-Pro");

    expect(await terminal.call("pending_comments", { pageId: page.id })).toMatch(/No comment to take/);
  });

  it("gives the threads in the agent message form with the page addresses, and takes them with the conversation's folder and machine", async () => {
    const { engine, page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro", { folder: `${homedir()}/crm` });

    const answer = await terminal.call("pending_comments", { pageId: page.id });

    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(answer).toContain("Make it blue");
    expect(answer).toContain("Page: ");
    expect(answer).toContain(page.id);
    expect(answer).toContain("home.html");
    const taken = await threadOf(page.id, thread.id);
    expect(taken).toMatchObject({ take: { folder: "~/crm", machine: "MacBook-Pro" } });
    expect(taken).not.toHaveProperty("toTake");
    expect(engine.runs).toHaveLength(0);
  });

  it("lists the threads the account already took, marked so, and takes nothing twice", async () => {
    const { page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });
    const second = await seam!.pinThread(page.id, "home.html", "Bigger title");

    const answer = await terminal.call("pending_comments", { pageId: page.id });

    expect(answer).toContain(`thread id: ${second.id}`);
    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(answer).toContain("[already taken by your account]");
    expect(answer.indexOf(`thread id: ${second.id}`)).toBeLessThan(answer.indexOf(`thread id: ${thread.id}`));
  });

  it("leaves the threads of the other pages alone", async () => {
    const { page } = await threadToTake();
    const other = await seam!.createPage(PAGE_FILES, "Contact", "conversation");
    const elsewhere = await seam!.pinThread(other.id, "home.html", "Other page");
    const terminal = await open("MacBook-Pro");

    await terminal.call("pending_comments", { pageId: page.id });

    expect(await threadOf(other.id, elsewhere.id)).toMatchObject({ toTake: true });
  });

  it("gives the comments even when a page's addresses cannot be fetched", async () => {
    const { page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro", {});
    void terminal;
    let failCheckout = false;
    const flaky = await openTerminal(seam!, stops, "Studio", {
      wrapApi: (api) => {
        const checkout = api.checkout.bind(api);
        api.checkout = async (pageId) => (failCheckout ? Promise.reject(new Error("server unavailable")) : checkout(pageId));
        return api;
      },
    });
    failCheckout = true;

    const answer = await flaky.call("pending_comments", { pageId: page.id });

    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(answer).toContain("could not be fetched");
    expect(await threadOf(page.id, thread.id)).toMatchObject({ take: { machine: "Studio" } });
  });
});

describe("a take belongs to the account, not to the process", () => {
  it("lets a new redline mcp process of the same account list and answer the threads the first took", async () => {
    const { page, thread } = await threadToTake();
    const first = await open("MacBook-Pro", { folder: "/work/crm" });
    await first.call("pending_comments", { pageId: page.id });
    await first.quit();

    const resumed = await open("MacBook-Pro", { folder: "/work/crm" });
    const answer = await resumed.call("pending_comments", { pageId: page.id });

    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(answer).toContain("[already taken by your account]");
    expect(await resumed.call("reply_in_thread", { threadId: thread.id, text: "Done, in blue" })).toContain("Reply posted");
    expect((await threadOf(page.id, thread.id)).replies.map((r) => r.body)).toEqual(["Done, in blue"]);
  });

  it("signs the answer with the conversation's folder and keeps the take", async () => {
    const { page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro", { folder: `${homedir()}/crm` });
    await terminal.call("pending_comments", { pageId: page.id });

    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done" });

    const answered = await threadOf(page.id, thread.id);
    expect(answered.replies[0]).toMatchObject({ author: "claude", conversation: { folder: "~/crm" } });
    expect(answered).toMatchObject({ take: { folder: "~/crm" } });
    expect(answered).not.toHaveProperty("toTake");
  });

  it("refuses a reply in a thread nobody took yet", async () => {
    const { page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro");

    expect(await terminal.call("reply_in_thread", { threadId: thread.id, text: "Too early" })).toMatch(/not taken by your account/);

    expect((await threadOf(page.id, thread.id)).replies).toEqual([]);
  });

  it("keeps a later message in the thread for the account: no agent run, shown as a relaunch, given again to any of its conversations", async () => {
    const { engine, page, thread } = await threadToTake();
    const terminal = await open("MacBook-Pro");
    await terminal.call("pending_comments", { pageId: page.id });
    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done" });

    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(engine.runs).toHaveLength(0);
    expect(await queueOf(page.id)).toEqual([]);
    expect(await threadOf(page.id, thread.id)).toMatchObject({ relaunch: true, take: { machine: "MacBook-Pro" } });
    const resumed = await open("MacBook-Pro");
    const answer = await resumed.call("pending_comments", { pageId: page.id });
    expect(answer).toContain("relaunched");
    expect(answer).toContain("Bigger please");
    await resumed.call("reply_in_thread", { threadId: thread.id, text: "Bigger" });
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("relaunch");
  });
});

describe("a thread an agent owns stays with it", () => {
  it("keeps the replies going to the agent, whatever the page's mode becomes", async () => {
    const { engine, page, thread } = await threadToTake("Make it blue", "agent");
    await seam!.waitForWorkEnd(1);
    await seam!.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "conversation" });

    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });

    await until(() => engine.runs.length === 2, "the agent to get the reply");
    expect(await threadOf(page.id, thread.id)).not.toHaveProperty("toTake");
  });

  it("is not to take for a conversation, and refuses its reply", async () => {
    const { page, thread } = await threadToTake("Make it blue", "agent");
    await seam!.waitForWorkEnd(1);
    await seam!.server.post(`/api/pages/${page.id}/comment-mode`, { mode: "conversation" });
    const terminal = await open("MacBook-Pro");

    expect(await terminal.call("pending_comments", { pageId: page.id })).toMatch(/No comment to take/);
    expect(await terminal.call("reply_in_thread", { threadId: thread.id, text: "Not mine" })).toMatch(/not taken by your account/);
    expect((await threadOf(page.id, thread.id)).replies.map((r) => r.body)).toEqual(["Agent answer"]);
  });
});

describe("the old hold model is gone", () => {
  it("publishing a page holds nothing: the next thread is still to take, and release_page does not exist", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES, "Accueil", "conversation");
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const thread = await seam.pinThread(page.id, "home.html", "One");

    expect(await threadOf(page.id, thread.id)).toMatchObject({ toTake: true });
    expect(await queueOf(page.id)).toEqual([]);
    expect(await terminal.call("release_page", {})).toMatch(/not found|unknown/i);
  });
});

describe("terminal session ids and sizes", () => {
  const send = async (path: string, body: unknown) => {
    const token = ((await (await seam!.server.get("/api/agent-token")).json()) as { token: string }).token;
    return fetch(`${seam!.server.url}/agent-api${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  };

  it("refuses an id that is not a UUID and an oversized folder or machine", async () => {
    seam = await startSeam2(answeringEngine());
    const id = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
    expect((await send(`/terminal-sessions/not-a-uuid/heartbeat`, { folder: "/a", machine: "m" })).status).toBe(400);
    expect((await send(`/terminal-sessions/${id}/heartbeat`, { folder: "x".repeat(600), machine: "m" })).status).toBe(400);
    expect((await send(`/terminal-sessions/${id}/heartbeat`, { folder: "/a", machine: "m".repeat(600) })).status).toBe(400);
    expect((await send(`/terminal-sessions/${id}/heartbeat`, { folder: "/a", machine: "m" })).status).toBe(204);
    expect((await send(`/terminal-sessions/not-a-uuid/bye`, {})).status).toBe(400);
  });

  it("refuses a take from a session that never sent its heartbeat", async () => {
    const { page } = await threadToTake();
    const id = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";

    expect((await send(`/terminal-sessions/${id}/take`, { pageId: page.id })).status).toBe(403);
  });
});
