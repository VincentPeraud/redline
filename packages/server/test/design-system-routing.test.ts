import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Conversation, DesignSystem, Project, QueueEntry, WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

/**
 * Who runs a design system's work: the online agent of the project the person opened the design system from, else the
 * online agent of the oldest project using it, else the default setting (the work waits, or the global agent takes it).
 */
describe("design system routing", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createDesignSystem(): Promise<DesignSystem> {
    return (await (await server.post("/api/design-systems", { title: "Lumora DS" })).json()) as DesignSystem;
  }
  async function createProject(title: string, designSystem?: string): Promise<Project> {
    return (await (await server.post("/api/projects", { title, ...(designSystem ? { designSystem } : {}) })).json()) as Project;
  }
  async function pin(ds: DesignSystem, body: string, viaProjectId?: string): Promise<Response> {
    const request = { artboard: "index.html", selector: "h1", xPct: 10, yPct: 10, body, ...(viaProjectId ? { viaProjectId } : {}) };
    return server.post(`/api/pages/${ds.pageId}/threads`, request);
  }
  async function connectProjectAgent(p: Project): Promise<TestAgent> {
    const agent = await server.connectAgent({ machine: "MacBook", folder: `/work/${p.title}`, projectId: p.id });
    await agent.hello;
    return agent;
  }
  async function connectGlobalAgent(): Promise<TestAgent> {
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/home/global", kind: "global" });
    await agent.hello;
    return agent;
  }
  async function queue(ds: DesignSystem): Promise<QueueEntry[]> {
    return (await (await server.get(`/api/pages/${ds.pageId}/queue`)).json()) as QueueEntry[];
  }
  const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  }

  it("runs the work on the agent of the project the design system was opened from", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const blog = await createProject("blog", ds.id);
    const frontAgent = await connectProjectAgent(front);
    const blogAgent = await connectProjectAgent(blog);

    expect((await pin(ds, "Rounder buttons", blog.id)).status).toBe(201);
    await until(() => received(blogAgent).length === 1);
    expect(received(frontAgent)).toHaveLength(0);
  });

  it("falls back to the agent of the oldest project using the design system", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const blog = await createProject("blog", ds.id);
    const frontAgent = await connectProjectAgent(front);
    const blogAgent = await connectProjectAgent(blog);

    await pin(ds, "Opened from the design systems list");
    await until(() => received(frontAgent).length === 1);
    expect(received(blogAgent)).toHaveLength(0);
  });

  it("uses another project's agent when the one it was opened from is not running", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const blog = await createProject("blog", ds.id);
    const frontAgent = await connectProjectAgent(front);

    await pin(ds, "Rounder buttons", blog.id);
    await until(() => received(frontAgent).length === 1);
    expect(received(frontAgent)[0]).toMatchObject({ resume: false });
  });

  it("ignores an origin project that does not use the design system", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const other = await createProject("other");
    const frontAgent = await connectProjectAgent(front);
    const otherAgent = await connectProjectAgent(other);

    expect((await pin(ds, "Rounder buttons", other.id)).status).toBe(201);
    await until(() => received(frontAgent).length === 1);
    expect(received(otherAgent)).toHaveLength(0);
  });

  it("follows the default setting when no project using it has an agent running", async () => {
    const ds = await createDesignSystem();
    await createProject("front", ds.id);
    const global = await connectGlobalAgent();

    await pin(ds, "Waits by default");
    await settle();
    expect(received(global)).toHaveLength(0);
    expect(await queue(ds)).toMatchObject([{ reason: "agent-offline" }]);

    await fetch(`${server.url}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeover: true }) });
    await until(() => received(global).length === 1);
  });

  it("runs the work of a design system no project uses yet on the global agent, whatever the default", async () => {
    const global = await connectGlobalAgent();
    const ds = (await (await server.post("/api/design-systems", { title: "Fresh", instructions: "A warm palette" })).json()) as DesignSystem;
    await until(() => received(global).length === 1);
    expect(received(global)[0]).toMatchObject({ resume: false });
    expect(ds.id).toBeTruthy();
  });

  it("lets the work wait while the agent of the project it was opened from updates, and runs other work of the page meanwhile", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const blog = await createProject("blog", ds.id);
    const frontAgent = await connectProjectAgent(front);
    const blogAgent = await connectProjectAgent(blog);
    const blogId = ((await blogAgent.hello) as { agentId: string }).agentId;
    await server.post(`/api/agents/${blogId}/update`, {});

    await pin(ds, "From blog", blog.id);
    await settle();
    expect(received(blogAgent).filter((m) => m.threads.length > 0)).toHaveLength(0);
    expect(received(frontAgent)).toHaveLength(0);
    expect(await queue(ds)).toMatchObject([{ reason: "agent-offline" }]);

    await pin(ds, "From front", front.id);
    await until(() => received(frontAgent).length === 1);
    expect(received(frontAgent)[0].message).toContain("From front");
  });

  it("tells the Sessions screen that a design system's work waits for an agent of a project using it", async () => {
    const ds = await createDesignSystem();
    await createProject("front", ds.id);
    await pin(ds, "Waits");
    await settle();
    const sessions = (await (await server.get("/api/sessions")).json()) as { name: string; waitingReason?: string }[];
    expect(sessions.find((s) => s.name === "Waits")).toMatchObject({ waitingReason: "design-system-agent-offline" });
  });

  it("runs a design system conversation on the agent of the project it was opened from", async () => {
    const ds = await createDesignSystem();
    const front = await createProject("front", ds.id);
    const blog = await createProject("blog", ds.id);
    const frontAgent = await connectProjectAgent(front);
    const blogAgent = await connectProjectAgent(blog);

    const conversation = (await (await server.post(`/api/pages/${ds.pageId}/conversations`, { viaProjectId: blog.id })).json()) as Conversation;
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add a danger colour" });
    await until(() => received(blogAgent).length === 1);
    expect(received(frontAgent)).toHaveLength(0);
  });
});
