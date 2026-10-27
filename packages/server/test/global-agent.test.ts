import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, Project, QueueEntry, Thread, WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

describe("global agent and takeover", () => {
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
  async function project(id: string): Promise<Project> {
    return (await (await server.get(`/api/projects/${id}`)).json()) as Project;
  }
  async function createPage(p: Project): Promise<Page> {
    const files = { "home.html": "<h1>Home</h1>" };
    return (await (await server.post(`/api/projects/${p.id}/pages`, { title: "Home", files })).json()) as Page;
  }
  async function pin(page: Page, body: string): Promise<Thread> {
    const request = { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body };
    return (await (await server.post(`/api/pages/${page.id}/threads`, request)).json()) as Thread;
  }
  async function queue(page: Page): Promise<QueueEntry[]> {
    return (await (await server.get(`/api/pages/${page.id}/queue`)).json()) as QueueEntry[];
  }
  async function allowTakeover(p: Project, allow = true): Promise<Response> {
    return fetch(`${server.url}/api/projects/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalTakeoverOverride: allow }),
    });
  }
  async function connectProjectAgent(p: Project, machine = "MacBook"): Promise<TestAgent> {
    const agent = await server.connectAgent({ machine, folder: "/work/acme", projectId: p.id });
    await agent.hello;
    return agent;
  }
  async function connectGlobalAgent(): Promise<TestAgent> {
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/home/neutral", kind: "global" });
    await agent.hello;
    return agent;
  }
  const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  }

  it("runs a thread of a project that never had a project agent on the global agent when it allows it", async () => {
    const acme = await createProject();
    await allowTakeover(acme);
    const page = await createPage(acme);
    const global = await connectGlobalAgent();
    const thread = await pin(page, "Make it blue");
    await until(() => received(global).length === 1);

    expect(received(global)[0]).toMatchObject({ resume: false, threads: [{ threadId: thread.id }] });
    expect((await project(acme.id)).servedBy).toMatchObject({ kind: "global", takeover: true, folder: "/home/neutral" });
  });

  it("keeps the thread of a project that never had a project agent waiting when it does not allow the global agent", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const global = await connectGlobalAgent();
    await pin(page, "Make it blue");
    await settle();
    expect(received(global)).toHaveLength(0);
    expect(await queue(page)).toMatchObject([{ reason: "agent-offline" }]);
    expect((await project(acme.id)).servedBy).toBeUndefined();
  });

  it("routes the same whether or not the project ever had an agent: a never-linked project and one with a stopped agent behave alike", async () => {
    const never = await createProject();
    const stoppedProject = (await (await server.post("/api/projects", { title: "Stopped" })).json()) as Project;
    const stopped = await connectProjectAgent(stoppedProject);
    stopped.close();
    await stopped.closed;
    await connectGlobalAgent();
    for (const allow of [false, true, false]) {
      for (const p of [never, stoppedProject]) await allowTakeover(p, allow);
      const served = await Promise.all([never, stoppedProject].map(async (p) => (await project(p.id)).servedBy?.kind));
      expect(served).toEqual(allow ? ["global", "global"] : [undefined, undefined]);
    }
  });

  it("keeps a stopped project agent listed as offline without changing routing", async () => {
    const acme = await createProject();
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const homeAgents = async () => ((await (await server.get("/api/home")).json()) as { agents: { status: string; kind: string }[] }).agents.map((a) => [a.kind, a.status]);
    for (let i = 0; i < 50 && (await homeAgents())[0]?.[1] !== "offline"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await homeAgents()).toEqual([["project", "offline"]]);
  });

  it("keeps a project's thread waiting for its offline project agent by default", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();
    await pin(page, "Is anyone there?");
    await settle();

    expect(received(global)).toEqual([]);
    expect(await queue(page)).toMatchObject([{ reason: "agent-offline" }]);
    expect((await project(acme.id)).servedBy).toBeUndefined();
  });

  it("starts a new session on the global agent when the project allows the takeover", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();
    await allowTakeover(acme);
    const thread = await pin(page, "Make it blue");
    await until(() => received(global).length === 1);

    expect(received(global)[0]).toMatchObject({ resume: false, threads: [{ threadId: thread.id }] });
    expect((await project(acme.id)).servedBy).toMatchObject({ kind: "global", takeover: true });
    expect((await project(acme.id)).globalTakeover).toBe(true);
  });

  it("sends the waiting thread to the global agent as soon as the takeover is allowed", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();
    await pin(page, "Waiting");
    await settle();
    expect(received(global)).toEqual([]);

    await allowTakeover(acme);
    await until(() => received(global).length === 1);
  });

  it("hands work back to the project agent once it is online again", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    await allowTakeover(acme);
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();
    await pin(page, "First");
    await until(() => received(global).length === 1);
    global.send({ type: "work-done", workId: received(global)[0].id });

    const back = await connectProjectAgent(acme);
    await pin(page, "Second");
    await until(() => received(back).length === 1);
    expect(received(global)).toHaveLength(1);
    expect((await project(acme.id)).servedBy).toMatchObject({ kind: "project", takeover: false });
  });

  it("answers a reply in a new session, with the conversation so far, when the opening agent is offline", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const projectAgent = await connectProjectAgent(acme);
    const thread = await pin(page, "Make it blue");
    await until(() => received(projectAgent).length === 1);
    const opening = received(projectAgent)[0];
    projectAgent.send({ type: "work-done", workId: opening.id });
    await settle();
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();

    await server.post(`/api/threads/${thread.id}/messages`, { body: "Darker please" });
    await settle();
    expect(received(global)).toEqual([]);

    await allowTakeover(acme);
    await until(() => received(global).length === 1);
    const item = received(global)[0];
    expect(item.resume).toBe(false);
    expect(item.sessionId).not.toBe(opening.sessionId);
    expect(item.message).toContain("Make it blue");
    expect(item.message).toContain("Darker please");
  });

  it("follows the global setting unless the project overrides it (effective = override ?? global)", async () => {
    const acme = await createProject();
    const page = await createPage(acme);
    const projectAgent = await connectProjectAgent(acme);
    projectAgent.close();
    await projectAgent.closed;
    const global = await connectGlobalAgent();
    const patchSettings = (globalTakeover: unknown) =>
      fetch(`${server.url}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeover }) });

    expect(await (await fetch(`${server.url}/api/settings`)).json()).toEqual({ globalTakeover: false });
    expect(await project(acme.id)).toMatchObject({ globalTakeover: false, globalTakeoverOverride: null });
    const waiting = await pin(page, "Make it blue");
    expect(await queue(page)).toHaveLength(1);

    expect(await (await patchSettings(true)).json()).toEqual({ globalTakeover: true });
    expect(await project(acme.id)).toMatchObject({ globalTakeover: true, globalTakeoverOverride: null });
    await until(() => received(global).length === 1);
    expect(received(global)[0].threads[0].threadId).toBe(waiting.id);

    // The project's own "always wait" beats the global setting; null goes back to following it.
    await allowTakeover(acme, false);
    expect(await project(acme.id)).toMatchObject({ globalTakeover: false, globalTakeoverOverride: false });
    await pin(page, "Another one");
    expect((await queue(page)).length).toBeGreaterThan(0);
    await fetch(`${server.url}/api/projects/${acme.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalTakeoverOverride: null }),
    });
    expect(await project(acme.id)).toMatchObject({ globalTakeover: true, globalTakeoverOverride: null });
    expect((await patchSettings("yes")).status).toBe(400);
  });

  it("refuses an invalid takeover setting and an unknown project", async () => {
    const acme = await createProject();
    const bad = await fetch(`${server.url}/api/projects/${acme.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalTakeoverOverride: "yes" }),
    });
    expect(bad.status).toBe(400);
    expect((await allowTakeover({ ...acme, id: "nope" })).status).toBe(404);
  });
});
