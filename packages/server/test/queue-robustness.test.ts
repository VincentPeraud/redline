import { afterEach, describe, expect, it, vi } from "vitest";
import {
  newSessionPath,
  pageRunsPath,
  retryRunPath,
  type Conversation,
  type DesignSystem,
  type Page,
  type Project,
  type QueueEntry,
  type Thread,
  type ThreadRun,
  type WorkItem,
} from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

const FILES = { "home.html": "<h1>Home</h1>" };

let server: TestServer;
afterEach(async () => {
  vi.useRealTimers();
  await server.stop();
});

async function setup(options: { retryDelaysMs?: number[] } = {}) {
  server = await startTestServer(options);
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as Page;
  return { project, page };
}
async function pin(page: Page, body: string): Promise<Thread> {
  const request = { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body };
  return (await (await server.post(`/api/pages/${page.id}/threads`, request)).json()) as Thread;
}
async function connect(options: { projectId?: string; folder?: string; kind?: "project" | "global" } = {}): Promise<TestAgent> {
  const agent = await server.connectAgent({ machine: "Mac", folder: options.folder ?? "/work/acme", ...options });
  await agent.hello;
  return agent;
}
const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
const queue = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/queue`)).json()) as QueueEntry[];
const runs = async (page: Page) => (await (await server.get(pageRunsPath(page.id))).json()) as ThreadRun[];
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150 && !(await condition()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await condition()).toBe(true);
}

describe("an item pinned to an agent that is no longer the project's agent", () => {
  it("moves to the current project agent in a new session, with the conversation so far", async () => {
    const { project, page } = await setup();
    const old = await connect({ projectId: project.id, folder: "/work/old" });
    const thread = await pin(page, "Make it blue");
    await until(() => received(old).length === 1);
    old.send({ type: "work-done", workId: received(old)[0].id });
    await settle();
    old.close();
    await old.closed;
    const replacement = await connect({ projectId: project.id, folder: "/work/new" });

    await server.post(`/api/threads/${thread.id}/messages`, { body: "Darker please" });
    await until(() => received(replacement).length === 1);
    const item = received(replacement)[0];
    expect(item.resume).toBe(false);
    expect(item.sessionId).not.toBe(received(old)[0].sessionId);
    expect(item.message).toContain("Make it blue");
    expect(item.message).toContain("Darker please");
    expect(await queue(page)).toEqual([]);
  });
});

describe("conversation and summary items whose agent was replaced", () => {
  async function replaceAgent(project: Project, old: TestAgent): Promise<TestAgent> {
    await settle();
    old.close();
    await old.closed;
    return connect({ projectId: project.id, folder: "/work/new" });
  }

  it("continues a conversation in a new session, with the conversation so far", async () => {
    const { project, page } = await setup();
    const old = await connect({ projectId: project.id, folder: "/work/old" });
    const conversation = (await (await server.post(`/api/pages/${page.id}/conversations`, {})).json()) as Conversation;
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add a footer" });
    await until(() => received(old).length === 1);
    old.send({ type: "work-event", workId: received(old)[0].id, event: { type: "result", summary: "Footer added." } });
    old.send({ type: "work-done", workId: received(old)[0].id });
    const replacement = await replaceAgent(project, old);

    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Make it sticky" });
    await until(() => received(replacement).length === 1);
    const item = received(replacement)[0];
    expect(item).toMatchObject({ kind: "conversation", resume: false, conversationId: conversation.id });
    expect(item.sessionId).not.toBe(received(old)[0].sessionId);
    expect(item.message).toContain("Add a footer");
    expect(item.message).toContain("Footer added.");
    expect(item.message).toContain("Make it sticky");

    replacement.send({ type: "work-done", workId: item.id });
    await settle();
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "And dark" });
    await until(() => received(replacement).length === 2);
    expect(received(replacement)[1]).toMatchObject({ resume: true, sessionId: item.sessionId });
  });

  it("asks a new session for the summary of a thread whose session is not available", async () => {
    const { project, page } = await setup();
    const old = await connect({ projectId: project.id, folder: "/work/old" });
    const thread = await pin(page, "Make it blue");
    await until(() => received(old).length === 1);
    old.send({ type: "work-done", workId: received(old)[0].id });
    const replacement = await replaceAgent(project, old);

    expect((await server.post(newSessionPath(thread.id), {})).status).toBe(202);
    await until(() => received(replacement).length === 1);
    const item = received(replacement)[0];
    expect(item).toMatchObject({ kind: "summary", resume: false });
    expect(item.sessionId).not.toBe(received(old)[0].sessionId);
    expect(item.message).toContain("Make it blue");
    replacement.send({ type: "work-event", workId: item.id, event: { type: "result", summary: "Blue it is." } });
    await until(async () => {
      const [t] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
      return t.newSession === "ready";
    });
  });
});

describe("the project's brief", () => {
  it("is sent when the project's first conversation is created, and only once", async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme", instructions: "Always use the brand blue." })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as Page;
    const agent = await connect({ projectId: project.id });

    const conversation = (await (await server.post(`/api/pages/${page.id}/conversations`, {})).json()) as Conversation;
    await until(() => received(agent).length === 1);
    expect(received(agent)[0]).toMatchObject({ kind: "conversation", conversationId: conversation.id });
    expect(received(agent)[0].message).toContain("Always use the brand blue.");
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await settle();

    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add a footer" });
    await until(() => received(agent).length === 2);
    expect(received(agent)[1].message).toContain("Add a footer");
    expect(received(agent)[1].message).not.toContain("brand blue");

    await server.post(`/api/pages/${page.id}/conversations`, {});
    await settle();
    expect(received(agent)).toHaveLength(2);
  });

  it("is not sent twice when the user writes before the agent is online", async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme", instructions: "Always use the brand blue." })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as Page;
    const conversation = (await (await server.post(`/api/pages/${page.id}/conversations`, {})).json()) as Conversation;
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add a footer" });

    const agent = await connect({ projectId: project.id });
    await until(() => received(agent).length === 1);
    await settle();
    expect(received(agent)).toHaveLength(1);
    const message = received(agent)[0].message;
    expect(message.match(/brand blue/g)).toHaveLength(1);
    expect(message).toContain("Add a footer");
  });
});

describe("work reports", () => {
  it("are ignored when they come from an agent the item was not sent to", async () => {
    const { project, page } = await setup();
    const owner = await connect({ projectId: project.id, folder: "/work/acme" });
    const other = await connect({ kind: "global", folder: "/home/neutral" });
    await pin(page, "First");
    const second = await pin(page, "Second");
    await until(() => received(owner).length === 1);

    other.send({ type: "work-done", workId: received(owner)[0].id });
    await settle();
    expect(received(owner)).toHaveLength(1);
    expect(await queue(page)).toMatchObject([{ threadIds: [second.id], reason: "page-busy" }]);

    owner.send({ type: "work-done", workId: received(owner)[0].id });
    await until(() => received(owner).length === 2);
  });
});

describe("a waiting pinned item and the rest of its page", () => {
  it("lets an item that another agent can run go first", async () => {
    server = await startTestServer();
    const acme = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const agent = await connect({ projectId: acme.id, folder: "/work/acme" });
    const designSystem = (await (await server.post("/api/design-systems", { title: "Brand", fromProjectId: acme.id })).json()) as DesignSystem;
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await settle();
    agent.close();
    await agent.closed;
    const global = await connect({ kind: "global", folder: "/home/neutral" });
    await fetch(`${server.url}/api/projects/${acme.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeoverOverride: true }) });

    const [conversation] = (await (await server.get(`/api/pages/${designSystem.pageId}/conversations`)).json()) as Conversation[];
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Make the primary colour warmer" });
    const page = { id: designSystem.pageId } as Page;
    await settle();
    expect(await queue(page)).toMatchObject([{ reason: "agent-offline" }]);

    const thread = await pin(page, "Rounder corners");
    await until(() => received(global).length === 1);
    expect(received(global)[0].threads[0].threadId).toBe(thread.id);
    expect(await queue(page)).toMatchObject([{ reason: "page-busy" }]);
  });
});

describe("retrying a failed item", () => {
  it("starts a fresh session instead of re-sending the id of one that may exist, and the thread follows it", async () => {
    const { project, page } = await setup({ retryDelaysMs: [20] });
    const agent = await connect({ projectId: project.id });
    const thread = await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    const first = received(agent)[0];

    agent.send({ type: "work-failed", workId: first.id, message: "Crashed halfway" });
    await until(() => received(agent).length === 2);
    const second = received(agent)[1];
    expect(second.id).toBe(first.id);
    expect(second.resume).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);

    agent.send({ type: "work-done", workId: second.id });
    await settle();
    await server.post(`/api/threads/${thread.id}/messages`, { body: "More" });
    await until(() => received(agent).length === 3);
    expect(received(agent)[2]).toMatchObject({ resume: true, sessionId: second.sessionId });
  });

  it("keeps the session of a resumed item", async () => {
    const { project, page } = await setup({ retryDelaysMs: [20] });
    const agent = await connect({ projectId: project.id });
    const thread = await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await settle();

    await server.post(`/api/threads/${thread.id}/messages`, { body: "More" });
    await until(() => received(agent).length === 2);
    agent.send({ type: "work-failed", workId: received(agent)[1].id, message: "Overloaded" });
    await until(() => received(agent).length === 3);
    expect(received(agent)[2]).toMatchObject({ resume: true, sessionId: received(agent)[0].sessionId });
  });

  it("puts a reply sent while the item waits for its retry into that item", async () => {
    const { project, page } = await setup({ retryDelaysMs: [300] });
    const agent = await connect({ projectId: project.id });
    const thread = await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-failed", workId: received(agent)[0].id, message: "Overloaded" });
    await settle();

    await server.post(`/api/threads/${thread.id}/messages`, { body: "Actually green" });
    await until(() => received(agent).length === 2);
    expect(received(agent)[1].message).toContain("Make it blue");
    expect(received(agent)[1].message).toContain("Actually green");
    await settle();
    expect(received(agent)).toHaveLength(2);
  });
});

describe("a limit message", () => {
  it("is read for its reset time: the next occurrence of a clock time", async () => {
    // A fixed day without a clock change: "3pm" is then exactly 5 h away, whatever today's date.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 5, 10, 10, 0, 0) });
    const { project, page } = await setup({ retryDelaysMs: [] });
    const agent = await connect({ projectId: project.id });
    const events: string[] = [];
    const abort = new AbortController();
    const reader = (await fetch(server.url + "/api/events", { signal: abort.signal })).body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        events.push(decoder.decode(value));
      }
    })().catch(() => undefined);

    await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-failed", workId: received(agent)[0].id, message: "You've hit your limit · resets 3pm" });
    await until(() => events.join("").includes('"work-retrying"'));
    abort.abort();

    const frame = events.join("").split("\n\n").find((f) => f.includes('"work-retrying"'))!;
    const event = JSON.parse(frame.slice(frame.indexOf("{"))) as { limit: boolean; retryAt: string };
    const retryAt = new Date(event.retryAt);
    expect(event.limit).toBe(true);
    expect([retryAt.getHours(), retryAt.getMinutes()]).toEqual([15, 0]);
    expect(retryAt.getTime()).toBe(new Date(2026, 5, 10, 15, 0, 0).getTime());
  });
});

describe("a server restart", () => {
  it("keeps a queued item, which runs when an agent connects", async () => {
    const { project, page } = await setup();
    const thread = await pin(page, "Anyone there?");
    await server.restart();

    expect(await queue(page)).toMatchObject([{ threadIds: [thread.id], reason: "agent-offline" }]);
    const agent = await connect({ projectId: project.id });
    await until(() => received(agent).length === 1);
    expect(received(agent)[0].threads[0].threadId).toBe(thread.id);
  });

  it("puts the item that was running back at the head of its page's queue", async () => {
    const { project, page } = await setup();
    const agent = await connect({ projectId: project.id });
    const first = await pin(page, "First");
    const second = await pin(page, "Second");
    await until(() => received(agent).length === 1);
    const runningId = received(agent)[0].id;

    await server.restart();
    expect((await queue(page)).map((e) => e.threadIds[0])).toEqual([first.id, second.id]);

    const again = await connect({ projectId: project.id });
    await until(() => received(again).length === 1);
    expect(received(again)[0]).toMatchObject({ id: runningId, threads: [{ threadId: first.id }] });
    again.send({ type: "work-done", workId: runningId });
    await until(() => received(again).length === 2);
    expect(received(again)[1].threads[0].threadId).toBe(second.id);
  });

  it("keeps an item waiting for its retry, with its run status", async () => {
    const { project, page } = await setup({ retryDelaysMs: [60_000] });
    const agent = await connect({ projectId: project.id });
    await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-failed", workId: received(agent)[0].id, message: "Overloaded" });
    await until(async () => (await runs(page)).some((r) => r.status === "retrying"));
    const before = (await runs(page))[0];

    await server.restart();
    const [after] = await runs(page);
    expect(after).toMatchObject({ workId: before.workId, status: "retrying", retryAt: before.retryAt, error: "Overloaded" });
  });

  it("keeps an item that failed for good, which Relancer still puts back in the queue", async () => {
    const { project, page } = await setup({ retryDelaysMs: [] });
    const agent = await connect({ projectId: project.id });
    await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    const workId = received(agent)[0].id;
    agent.send({ type: "work-failed", workId, message: "Crashed" });
    await until(async () => (await runs(page)).some((r) => r.status === "failed"));

    await server.restart();
    expect(await runs(page)).toMatchObject([{ workId, status: "failed", error: "Crashed" }]);
    const again = await connect({ projectId: project.id });
    expect((await server.post(retryRunPath(page.id, workId), {})).status).toBe(204);
    await until(() => received(again).length === 1);
    expect(received(again)[0].id).toBe(workId);
  });

  it("finishes a new-session summary that was waiting when the server stopped", async () => {
    const { project, page } = await setup();
    const agent = await connect({ projectId: project.id });
    const thread = await pin(page, "Make it blue");
    await until(() => received(agent).length === 1);
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await settle();
    agent.close();
    await agent.closed;

    expect((await server.post(newSessionPath(thread.id), {})).status).toBe(202);
    await server.restart();
    const again = await connect({ projectId: project.id });
    await until(() => received(again).length === 1);
    expect(received(again)[0].kind).toBe("summary");
    again.send({ type: "work-event", workId: received(again)[0].id, event: { type: "result", summary: "Blue it is." } });
    await until(async () => {
      const [t] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
      return t.newSession === "ready";
    });
  });
});
