import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project, QueueEntry, Thread, WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

const FILES = { "home.html": "<h1>Home</h1>", "about.html": "<h1>About</h1>" };

describe("page lock and queue", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createProject(): Promise<Project> {
    return (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  }
  async function createPage(project: Project, title: string): Promise<Page> {
    return (await (await server.post(`/api/projects/${project.id}/pages`, { title, type: "prototype", files: FILES })).json()) as Page;
  }
  async function pin(page: Page, body: string): Promise<Thread> {
    const request = { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body };
    return (await (await server.post(`/api/pages/${page.id}/threads`, request)).json()) as Thread;
  }
  async function queue(page: Page): Promise<QueueEntry[]> {
    return (await (await server.get(`/api/pages/${page.id}/queue`)).json()) as QueueEntry[];
  }
  async function connect(project: Project): Promise<TestAgent> {
    const agent = await server.connectAgent({ projectId: project.id });
    await agent.hello;
    return agent;
  }
  const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  }

  it("runs two threads of the same page one after the other, in order", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    const first = await pin(page, "First");
    const second = await pin(page, "Second");
    await settle();

    expect(received(agent).map((i) => i.threads[0].threadId)).toEqual([first.id]);
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await until(() => received(agent).length === 2);
    expect(received(agent)[1].threads[0].threadId).toBe(second.id);
  });

  it("grants the next thread when the running one fails", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    await pin(page, "First");
    await pin(page, "Second");
    await settle();

    agent.send({ type: "work-failed", workId: received(agent)[0].id, message: "boom" });
    await until(() => received(agent).length === 2);
  });

  it("runs threads of two different pages in parallel", async () => {
    const project = await createProject();
    const home = await createPage(project, "Home");
    const about = await createPage(project, "About");
    const agent = await connect(project);
    await pin(home, "On home");
    await pin(about, "On about");

    await until(() => received(agent).length === 2);
    expect(received(agent).map((i) => i.pageId).sort()).toEqual([home.id, about.id].sort());
  });

  it("tells a waiting thread why it waits: page busy while another session runs", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    await pin(page, "First");
    const second = await pin(page, "Second");
    await settle();

    expect(await queue(page)).toEqual([
      { workId: expect.any(String), pageId: page.id, threadIds: [second.id], reason: "page-busy" },
    ]);
    agent.send({ type: "work-done", workId: received(agent)[0].id });
    await until(() => received(agent).length === 2);
    expect(await queue(page)).toEqual([]);
  });

  it("tells a waiting thread why it waits: agent offline", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const thread = await pin(page, "Anyone there?");

    expect(await queue(page)).toEqual([
      { workId: expect.any(String), pageId: page.id, threadIds: [thread.id], reason: "agent-offline" },
    ]);
  });

  it("runs a thread sent while the agent was offline once the agent reconnects", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const thread = await pin(page, "Anyone there?");
    const agent = await connect(project);

    await until(() => received(agent).length === 1);
    expect(received(agent)[0].threads[0].threadId).toBe(thread.id);
    expect(await queue(page)).toEqual([]);
  });

  it("puts a running item back in the queue when its agent drops, and runs it when an agent returns", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const first = await connect(project);
    const thread = await pin(page, "Long job");
    await until(() => received(first).length === 1);

    first.close();
    await first.closed;
    await settle();
    expect((await queue(page)).map((e) => e.reason)).toEqual(["agent-offline"]);

    const second = await connect(project);
    await until(() => received(second).length === 1);
    expect(received(second)[0].threads[0].threadId).toBe(thread.id);
  });

  it("emits queue-updated when a page's queue changes", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const chunks: string[] = [];
    const abort = new AbortController();
    const reader = (await fetch(server.url + "/api/events", { signal: abort.signal })).body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        chunks.push(decoder.decode(value));
      }
    })().catch(() => undefined);

    await pin(page, "Waiting");
    await until(() => chunks.join("").includes('"queue-updated"'));
    abort.abort();
  });
});
