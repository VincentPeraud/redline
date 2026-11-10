import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, AgentCloseCode, type AgentTokenResponse, type HomeOverview, type Page } from "@redline/shared";
import { AccountsInstance, FILES, type SignedIn } from "./accounts-harness.js";

const tokenOf = async (who: SignedIn) => (await who.json<AgentTokenResponse>("/api/agent-token")).token;
const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("one agent token per person", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const agentCall = (token: string, path: string) => fetch(instance.server.url + AGENT_API_PREFIX + path, { headers: { authorization: `Bearer ${token}` } });

  it("gives every account its own token, and regenerating one only disconnects that person's agents", async () => {
    const { admin, ariane } = instance;
    const [adminToken, arianeToken] = [await tokenOf(admin), await tokenOf(ariane)];
    expect(adminToken).not.toBe(arianeToken);
    expect(await tokenOf(admin)).toBe(adminToken);
    const adminAgent = await instance.connectAgent(adminToken, { folder: "/admin" });
    const arianeAgent = await instance.connectAgent(arianeToken, { folder: "/ariane" });
    expect((await adminAgent.hello).type).toBe("welcome");
    expect((await arianeAgent.hello).type).toBe("welcome");

    const fresh = ((await (await ariane.send("POST", "/api/agent-token/regenerate")).json()) as AgentTokenResponse).token;

    expect(fresh).not.toBe(arianeToken);
    expect(await arianeAgent.closed).toEqual({ code: AgentCloseCode.Unauthorized });
    await expect((await instance.connectAgent(arianeToken)).hello).resolves.toMatchObject({ type: "error", code: "unauthorized" });
    expect((await (await instance.connectAgent(fresh, { folder: "/ariane2" })).hello).type).toBe("welcome");
    expect(await tokenOf(admin)).toBe(adminToken);
    adminAgent.close();
  });

  it("turns the old shared token into the first admin's token", async () => {
    const db = new Database(join(instance.dataDir, "redline.db"));
    db.prepare("INSERT INTO settings (key, value) VALUES ('agent_token', 'abt_old') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.close();

    const agent = await instance.connectAgent("abt_old");
    expect((await agent.hello).type).toBe("welcome");
    expect(await tokenOf(instance.admin)).toBe("abt_old");
    expect(await tokenOf(instance.ariane)).not.toBe("abt_old");
    agent.close();
  });

  it("limits an agent to the projects where its person has Écriture", async () => {
    const { admin, ariane, people } = instance;
    const project = await instance.createProject(admin, { visibility: "private" });
    const pageId = await instance.createPage(admin, project.id);
    const arianeToken = await tokenOf(ariane);
    const adminToken = await tokenOf(admin);

    expect((await agentCall(arianeToken, `/pages/${pageId}/files`)).status).toBe(403);
    expect((await agentCall(adminToken, `/pages/${pageId}/files`)).status).toBe(200);

    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "read" });
    expect((await agentCall(arianeToken, `/pages/${pageId}/files`)).status).toBe(403);
    expect(((await (await agentCall(arianeToken, "/projects")).json()) as { id: string }[]).map((p) => p.id)).not.toContain(project.id);

    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "write" });
    expect((await agentCall(arianeToken, `/pages/${pageId}/files`)).status).toBe(200);
    expect(((await (await agentCall(arianeToken, "/projects")).json()) as { id: string }[]).map((p) => p.id)).toContain(project.id);
  });

  it("sends a project's work to its agent only while that agent's person has Écriture", async () => {
    const { admin, ariane, people } = instance;
    const project = await instance.createProject(admin);
    const pageId = await instance.createPage(admin, project.id);
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "read" });
    const agent = await instance.connectAgent(await tokenOf(ariane), { projectId: project.id });
    await agent.hello;
    const comment = () => admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger" });

    await comment();
    await tick();
    expect(agent.messages.filter((m) => m.type === "work")).toHaveLength(0);

    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "write" });
    await comment();
    await tick();
    expect(agent.messages.filter((m) => m.type === "work").length).toBeGreaterThan(0);
    agent.close();
  });

  it("revokes the token and closes the agents of a deactivated account", async () => {
    const { admin, ariane, people } = instance;
    const arianeToken = await tokenOf(ariane);
    const agent = await instance.connectAgent(arianeToken);
    await agent.hello;

    expect((await admin.send("POST", `/api/accounts/${people.ariane.id}/deactivate`)).status).toBe(200);

    expect(await agent.closed).toEqual({ code: AgentCloseCode.Unauthorized });
    expect((await agentCall(arianeToken, "/projects")).status).toBe(401);
  });

  it("releases the pages held by the terminal session of a deactivated account and sends their waiting work to the agents", async () => {
    const { admin, ariane, people } = instance;
    const project = await instance.createProject(admin);
    const pageId = await instance.createPage(admin, project.id);
    const session = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";
    const arianeCall = async (path: string, body: unknown) =>
      fetch(instance.server.url + AGENT_API_PREFIX + path, { method: "POST", headers: { authorization: `Bearer ${await tokenOf(ariane)}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const page = await admin.json<Page>(`/api/pages/${pageId}`);
    await arianeCall(`/terminal-sessions/${session}/heartbeat`, { folder: "/work", machine: "mac" });
    const files = { ...FILES, "home.html": "<h1>Terminal</h1>" };
    expect((await arianeCall(`/pages/${pageId}/versions`, { files, message: "Terminal", origin: "terminal", baseVersionId: page.version.id, terminalSessionId: session })).status).toBe(201);
    const agent = await instance.connectAgent(await tokenOf(admin), { projectId: project.id });
    await agent.hello;
    await admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger" });
    await tick();
    expect(agent.messages.filter((m) => m.type === "work")).toHaveLength(0);

    await admin.send("POST", `/api/accounts/${people.ariane.id}/deactivate`);
    await tick();

    expect(agent.messages.filter((m) => m.type === "work")).toHaveLength(1);
    agent.close();
  });

  it("lists every agent with who launched it, and masks the project of a Privé project the viewer cannot see", async () => {
    const { admin, ariane } = instance;
    const project = await instance.createProject(admin, { title: "Secret", visibility: "private" });
    const agent = await instance.connectAgent(await tokenOf(admin), { projectId: project.id, folder: "/secret" });
    await agent.hello;

    const seenByAdmin = await admin.json<HomeOverview>("/api/home");
    const seenByAriane = await ariane.json<HomeOverview>("/api/home");

    expect(seenByAdmin.agents[0]).toMatchObject({ launchedBy: { name: "Vincent Peraud" }, projects: [{ title: "Secret" }] });
    expect(seenByAriane.agents[0]).toMatchObject({ launchedBy: { name: "Vincent Peraud" }, projects: [{ title: "Projet privé", private: true }] });
    expect(JSON.stringify(seenByAriane)).not.toContain("Secret");
    agent.close();
  });
});

it("keeps the old shared token working with admin rights until an admin exists", async () => {
  const fresh = new AccountsInstance();
  const { startServer } = await import("../src/start.js");
  fresh.server = await startServer({ dataDir: fresh.dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", authMode: "local", log: () => {} });
  try {
    const db = new Database(join(fresh.dataDir, "redline.db"));
    db.prepare("INSERT INTO settings (key, value) VALUES ('agent_token', 'abt_old') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.close();
    const res = await fetch(fresh.server.url + AGENT_API_PREFIX + "/projects", { headers: { authorization: "Bearer abt_old" } });
    expect(res.status).toBe(200);
    await expect((await fresh.connectAgent("abt_old")).hello).resolves.toMatchObject({ type: "welcome" });
  } finally {
    await fresh.close();
  }
});
