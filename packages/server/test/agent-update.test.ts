import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type AgentInfo, type HomeOverview, type Page, type Project, type WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "../src/test-harness.js";

describe("updating an agent from the browser", () => {
  let cliDir: string;
  let server: TestServer;

  beforeEach(async () => {
    cliDir = mkdtempSync(join(tmpdir(), "redline-update-"));
    writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
    writeFileSync(join(cliDir, "build-hash.txt"), "server-build");
    server = await startTestServer({ cliDir });
  });
  afterEach(async () => {
    await server.stop();
    rmSync(cliDir, { recursive: true, force: true });
  });

  const agents = async () => (await (await server.get("/api/agents")).json()) as AgentInfo[];
  const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  }
  async function connect(options: Parameters<TestServer["connectAgent"]>[0]): Promise<{ agent: TestAgent; id: string }> {
    const agent = await server.connectAgent(options);
    const welcome = await agent.hello;
    if (welcome.type !== "welcome") throw new Error("not welcomed");
    return { agent, id: welcome.agentId };
  }
  const requestUpdate = (id: string) => server.post(`/api/agents/${id}/update`, {});
  async function pinOnNewProject(): Promise<{ project: Project; pin: () => Promise<Response> }> {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    await fetch(`${server.url}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalTakeoverOverride: true }),
    });
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>" } })).json()) as Page;
    return { project, pin: () => server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "Make it blue" }) };
  }

  it("sends the update message to the connected agent and lists it as updating", async () => {
    const { agent, id } = await connect({ kind: "global", folder: "/global", buildHash: "old-build" });
    expect((await requestUpdate(id)).status).toBe(202);
    await until(() => agent.messages.some((m) => m.type === "update"));
    expect((await agents())[0]).toMatchObject({ updating: true });
  });

  it("answers 404 for an agent that is not connected", async () => {
    const { agent, id } = await connect({ kind: "global", folder: "/global" });
    agent.close();
    await agent.closed;
    await expect.poll(async () => (await agents())[0].status).toBe("offline");
    expect((await requestUpdate(id)).status).toBe(404);
    expect((await requestUpdate("nobody")).status).toBe(404);
  });

  it("stops dispatching new work to an updating agent, and resumes when it reports a failure", async () => {
    const { pin } = await pinOnNewProject();
    const { agent, id } = await connect({ kind: "global", folder: "/global" });
    await requestUpdate(id);
    await pin();
    await settle();
    expect(received(agent)).toHaveLength(0);

    agent.send({ type: "update-failed", message: "npm ERR! 404" });
    await until(() => received(agent).length === 1);
    expect((await agents())[0]).toMatchObject({ updateError: "npm ERR! 404" });
    expect((await agents())[0].updating).toBeUndefined();
  });

  it("holds a project's work for its updating project agent instead of handing it to the global agent", async () => {
    const { project, pin } = await pinOnNewProject();
    const global = await connect({ kind: "global", folder: "/global" });
    const projectAgent = await connect({ folder: "/work/acme", projectId: project.id });
    await requestUpdate(projectAgent.id);
    await pin();
    await settle();
    expect(received(global.agent)).toHaveLength(0);
    expect(received(projectAgent.agent)).toHaveLength(0);
  });

  it("clears the updating state and the error when the agent connects again", async () => {
    const { agent, id } = await connect({ kind: "global", folder: "/global" });
    await requestUpdate(id);
    agent.send({ type: "update-failed", message: "boom" });
    await expect.poll(async () => (await agents())[0].updateError).toBe("boom");
    agent.close();
    await agent.closed;
    await connect({ kind: "global", folder: "/global", buildHash: "server-build" });
    expect((await agents())[0].updateError).toBeUndefined();
    expect((await agents())[0].updating).toBeUndefined();
  });
});

describe("refused agents", () => {
  it("record the project a project agent was serving, and none for a global agent", async () => {
    const server = await startTestServer();
    try {
      const project = (await (await server.post("/api/projects", { title: "Blog Lumora" })).json()) as Project;
      const projectAgent = await server.connectAgent({ machine: "iMac", folder: "/blog", projectId: project.id, protocolVersion: PROTOCOL_VERSION + 1 });
      await projectAgent.hello;
      const globalAgent = await server.connectAgent({ machine: "iMac", folder: "/global", kind: "global", protocolVersion: PROTOCOL_VERSION + 1 });
      await globalAgent.hello;
      const home = (await (await server.get("/api/home")).json()) as HomeOverview;
      expect(home.refusedAgents).toMatchObject([{ folder: "/blog", project: "Blog Lumora" }, { folder: "/global" }]);
      expect(home.refusedAgents[1]).not.toHaveProperty("project");
    } finally {
      await server.stop();
    }
  });
});
