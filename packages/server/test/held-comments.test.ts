import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project, SendHeldResponse, Thread, WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

const FILES = { "home.html": "<h1>Home</h1>" };

describe("held comments and batches", () => {
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
  async function hold(page: Page, body: string, selector = "h1"): Promise<Thread> {
    const request = { artboard: "home.html", selector, xPct: 10, yPct: 20, body, held: true };
    return (await (await server.post(`/api/pages/${page.id}/threads`, request)).json()) as Thread;
  }
  async function pin(page: Page, body: string): Promise<Thread> {
    const request = { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body };
    return (await (await server.post(`/api/pages/${page.id}/threads`, request)).json()) as Thread;
  }
  const threadsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  const patch = (path: string, body: unknown) =>
    fetch(server.url + path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const remove = (path: string) => fetch(server.url + path, { method: "DELETE" });
  const sendHeld = (page: Page, body: unknown = {}) => server.post(`/api/pages/${page.id}/send-held`, body);
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

  it("stores a held comment without sending it, visible to any client", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    const held = await hold(page, "Later");
    await settle();

    expect(held.status).toBe("held");
    expect(received(agent)).toEqual([]);
    expect((await threadsOf(page)).map((t) => [t.body, t.status])).toEqual([["Later", "held"]]);
    const listed = (await (await server.get(`/api/pages/${page.id}/held`)).json()) as Thread[];
    expect(listed.map((t) => t.id)).toEqual([held.id]);
  });

  it("edits and deletes a held comment, and refuses both once it was sent", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const first = await hold(page, "Draft");
    const second = await hold(page, "Drop me");

    const edited = (await (await patch(`/api/threads/${first.id}`, { body: "Better" })).json()) as Thread;
    expect([edited.body, edited.title, edited.status]).toEqual(["Better", "Better", "held"]);
    expect((await remove(`/api/threads/${second.id}`)).status).toBe(204);
    expect((await threadsOf(page)).map((t) => t.id)).toEqual([first.id]);

    await sendHeld(page);
    expect((await patch(`/api/threads/${first.id}`, { body: "Too late" })).status).toBe(409);
    expect((await remove(`/api/threads/${first.id}`)).status).toBe(409);
  });

  it("sends the held comments of the page as one work item, listing every comment, and leaves the other pages' held comments alone", async () => {
    const project = await createProject();
    const home = await createPage(project, "Home");
    const about = await createPage(project, "About");
    const agent = await connect(project);
    const a = await hold(home, "Bigger title", "h1.title");
    const b = await hold(home, "Rounder button", "button");
    const c = await hold(about, "Fix footer", "footer");

    const response = (await (await sendHeld(home, { model: "sonnet", effort: "high" })).json()) as SendHeldResponse;
    expect(response).toEqual({ threads: 2 });
    await until(() => received(agent).length === 1);
    await settle();
    expect(received(agent)).toHaveLength(1);

    const homeItem = received(agent)[0];
    expect(homeItem.pageId).toBe(home.id);
    expect(homeItem.threads.map((t) => t.threadId)).toEqual([a.id, b.id]);
    expect([homeItem.model, homeItem.effort]).toEqual(["sonnet", "high"]);
    for (const thread of [a, b]) {
      expect(homeItem.message).toContain(`thread id: ${thread.id}`);
      expect(homeItem.message).toContain("artboard home.html");
      expect(homeItem.message).toContain(`element \`${thread.selector}\``);
      expect(homeItem.message).toContain("position 10% / 20%");
      expect(homeItem.message).toContain(thread.body);
    }
    expect(homeItem.message).not.toContain(c.id);
    expect((await threadsOf(home)).map((t) => t.status)).toEqual(["open", "open"]);
    expect((await (await server.get(`/api/pages/${home.id}/held`)).json()) as Thread[]).toEqual([]);
    expect((await threadsOf(about)).map((t) => t.status)).toEqual(["held"]);

    expect(await (await sendHeld(about)).json()).toEqual({ threads: 1 });
    await until(() => received(agent).length === 2);
    expect(received(agent)[1].threads.map((t) => t.threadId)).toEqual([c.id]);
    expect(await (await sendHeld(about)).json()).toEqual({ threads: 0 });
  });

  it("answers a reply in a batched thread by resuming the shared session for that thread only", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    const a = await hold(page, "One");
    await hold(page, "Two");
    await sendHeld(page);
    await until(() => received(agent).length === 1);
    const batch = received(agent)[0];
    agent.send({ type: "work-done", workId: batch.id });
    await settle();

    await server.post(`/api/threads/${a.id}/messages`, { body: "Actually darker", effort: "low" });
    await until(() => received(agent).length === 2);
    const resumed = received(agent)[1];
    expect([resumed.resume, resumed.sessionId]).toEqual([true, batch.sessionId]);
    expect(resumed.threads.map((t) => t.threadId)).toEqual([a.id]);
    expect(resumed.effort).toBe("low");
  });

  it("merges pending replies of threads sharing a session into one message", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const agent = await connect(project);
    const a = await hold(page, "One");
    const b = await hold(page, "Two");
    await sendHeld(page);
    await until(() => received(agent).length === 1);
    const batch = received(agent)[0];

    await server.post(`/api/threads/${a.id}/messages`, { body: "reply A" });
    await server.post(`/api/threads/${b.id}/messages`, { body: "reply B", model: "haiku" });
    await settle();
    expect(received(agent)).toHaveLength(1);
    agent.send({ type: "work-done", workId: batch.id });
    await until(() => received(agent).length === 2);
    await settle();

    const merged = received(agent)[1];
    expect(received(agent)).toHaveLength(2);
    expect(merged.resume).toBe(true);
    expect(merged.threads.map((t) => t.threadId)).toEqual([a.id, b.id]);
    expect(merged.message).toContain("reply A");
    expect(merged.message).toContain("reply B");
    expect(merged.model).toBe("haiku");
  });

  it("merges a reply into the pending message of a thread whose item is still queued", async () => {
    const project = await createProject();
    const page = await createPage(project, "Home");
    const thread = await pin(page, "First comment");
    await server.post(`/api/threads/${thread.id}/messages`, { body: "one more thing" });
    const agent = await connect(project);
    await until(() => received(agent).length === 1);
    await settle();

    const [item] = received(agent);
    expect(received(agent)).toHaveLength(1);
    expect(item.resume).toBe(false);
    expect(item.message).toContain("First comment");
    expect(item.message).toContain("one more thing");
  });
});
