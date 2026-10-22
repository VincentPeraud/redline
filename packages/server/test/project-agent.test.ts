import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCloseCode, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "../src/test-harness.js";

describe("project agent", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createProject(title: string): Promise<Project> {
    return (await (await server.post("/api/projects", { title })).json()) as Project;
  }
  async function projects(): Promise<Project[]> {
    return (await (await server.get("/api/projects")).json()) as Project[];
  }

  it("shows which agent serves a project", async () => {
    const project = await createProject("Acme");
    expect((await projects())[0].agent).toBeUndefined();
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id });
    await agent.hello;
    expect((await projects())[0].agent).toMatchObject({ machine: "MacBook", folder: "/work/acme", status: "online" });
  });

  it("refuses a second project agent naming the one already serving the project", async () => {
    const project = await createProject("Acme");
    await (await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id })).hello;
    const second = await server.connectAgent({ machine: "iMac", folder: "/other/acme", projectId: project.id });
    expect(await second.hello).toMatchObject({ type: "error", code: "project_taken", message: expect.stringContaining("MacBook") });
    expect((await second.closed).code).toBe(AgentCloseCode.ProjectTaken);
  });

  it("lets a new agent take over once the old one is offline", async () => {
    const project = await createProject("Acme");
    const first = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id });
    await first.hello;
    first.close();
    await first.closed;
    const again = await server.connectAgent({ machine: "iMac", folder: "/other/acme", projectId: project.id });
    expect(await again.hello).toMatchObject({ type: "welcome" });
    expect((await projects())[0].agent).toMatchObject({ machine: "iMac" });
  });

  it("refuses an unknown project", async () => {
    const agent = await server.connectAgent({ projectId: "nope" });
    expect(await agent.hello).toMatchObject({ type: "error", code: "unknown_project" });
  });
});
