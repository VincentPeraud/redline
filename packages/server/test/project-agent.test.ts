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

  it("serves every project linked to its folder", async () => {
    const studio = await createProject("Reel studio");
    const chills = await createProject("Sueurs froides");
    await (await server.connectAgent({ machine: "MacBook", folder: "/work/reel", projectIds: [studio.id, chills.id] })).hello;
    expect((await projects()).map((p) => p.agent?.folder)).toEqual(["/work/reel", "/work/reel"]);
    const home = (await (await server.get("/api/home")).json()) as { agents: { projects: { title: string; servedNow: boolean }[] }[] };
    expect(home.agents[0].projects).toEqual([
      expect.objectContaining({ title: "Reel studio", servedNow: true }),
      expect.objectContaining({ title: "Sueurs froides", servedNow: true }),
    ]);
  });

  it("stops serving a project that is no longer linked when the agent reconnects", async () => {
    const studio = await createProject("Reel studio");
    const chills = await createProject("Sueurs froides");
    const first = await server.connectAgent({ machine: "MacBook", folder: "/work/reel", projectIds: [studio.id, chills.id] });
    await first.hello;
    first.close();
    await first.closed;
    await (await server.connectAgent({ machine: "MacBook", folder: "/work/reel", projectIds: [chills.id] })).hello;
    expect((await projects()).map((p) => p.agent?.folder)).toEqual([undefined, "/work/reel"]);
  });

  it("refuses an agent when one of its projects is served elsewhere, naming that project", async () => {
    const studio = await createProject("Reel studio");
    const chills = await createProject("Sueurs froides");
    await (await server.connectAgent({ machine: "iMac", folder: "/other", projectIds: [chills.id] })).hello;
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/work/reel", projectIds: [studio.id, chills.id] });
    expect(await agent.hello).toMatchObject({ type: "error", code: "project_taken", message: expect.stringMatching(/Sueurs froides.*iMac/) });
    expect((await projects())[0].agent).toBeUndefined();
  });

  it("refuses an unknown project", async () => {
    const agent = await server.connectAgent({ projectId: "nope" });
    expect(await agent.hello).toMatchObject({ type: "error", code: "unknown_project" });
  });
});
