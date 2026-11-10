import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startAgent } from "../src/agent.js";
import type { AgentConnection } from "../src/connection.js";
import { FakeEngine } from "./support/fake-engine.js";

let server: TestServer | undefined;
let folders: string[] = [];
let agents: AgentConnection[] = [];

afterEach(async () => {
  for (const agent of agents) agent.close();
  await server?.stop();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  server = undefined;
  folders = [];
  agents = [];
});

async function startAgentIn(kind: "project" | "global", engine: FakeEngine, projectId?: string, machine = "test-machine"): Promise<AgentConnection> {
  const folder = mkdtempSync(join(tmpdir(), "redline-agent-folder-"));
  folders.push(folder);
  const { token } = (await (await server!.get("/api/agent-token")).json()) as AgentTokenResponse;
  const agent = await startAgent({ serverUrl: server!.url, token, machine, folder, kind, projectIds: projectId ? [projectId] : undefined, engine });
  agents.push(agent);
  return agent;
}

describe("global agent", () => {
  it("answers a thread of a project that has no project agent, and the project shows it", async () => {
    server = await startTestServer();
    const engine = new FakeEngine([
      { edit: { path: "home.html", content: "<h1>Blue</h1>" } },
      { type: "result", summary: "Make it blue" },
    ]);
    await startAgentIn("global", engine);
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    await fetch(`${server.url}/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeoverOverride: true }) });
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>" } })).json()) as Page;
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "Make it blue" });
    await engine.finished(1);

    expect(engine.runs[0].resume).toBe(false);
    const served = (await (await server.get(`/api/projects/${project.id}`)).json()) as Project;
    expect(served.servedBy).toMatchObject({ kind: "global", takeover: true });
  });

  it("takes over a thread of an offline project agent in a new session once the project allows it", async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>" } })).json()) as Page;
    const projectEngine = new FakeEngine([{ type: "result", summary: "Opened" }]);
    const projectAgent = await startAgentIn("project", projectEngine, project.id, "MacBook");
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "First" });
    await projectEngine.finished(1);
    await expect
      .poll(async () => ((await (await server!.get(`/api/pages/${page.id}/runs`)).json()) as { status: string }[]).map((r) => r.status))
      .toEqual(["answered"]);
    projectAgent.close();
    await projectAgent.closed;

    const globalEngine = new FakeEngine([{ type: "result", summary: "Taken over" }]);
    await startAgentIn("global", globalEngine, undefined, "iMac");
    const [thread] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    await server.post(`/api/threads/${thread.id}/messages`, { body: "Now darker" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(globalEngine.runs).toEqual([]);

    await fetch(`${server.url}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ globalTakeoverOverride: true }),
    });
    await globalEngine.finished(1);

    expect(globalEngine.runs[0].resume).toBe(false);
    expect(globalEngine.runs[0].message).toContain("Now darker");
  });
});
