import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type Thread } from "@redline/shared";
import { AccountsInstance, type TestAgent } from "./accounts-harness.js";

const SESSION = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";

describe("Libérer and Confier à l'agent between accounts", () => {
  let instance: AccountsInstance;
  let agent: TestAgent | undefined;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(async () => {
    agent?.close();
    agent = undefined;
    await instance.close();
  });

  /** Ariane and Thomas have Écriture, Marc only Commentaire; Thomas's conversation took the thread. */
  async function setup() {
    const { admin, people } = instance;
    const project = await instance.createProject(admin);
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.ariane.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.thomas.id}`, { level: "write" });
    await admin.send("PUT", `/api/projects/${project.id}/members/${people.marc.id}`, { level: "comment" });
    const pageId = await instance.createPage(admin, project.id, "Partager", "conversation");
    const thread = (await (await admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger" })).json()) as Thread;
    const { token } = await instance.thomas.json<AgentTokenResponse>("/api/agent-token");
    const call = (path: string, body: unknown) => fetch(`${instance.server.url}${AGENT_API_PREFIX}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await call(`/terminal-sessions/${SESSION}/heartbeat`, { folder: "/Users/tom/site", machine: "MacBook-Air" });
    await call(`/terminal-sessions/${SESSION}/take`, { pageId });
    return { project, pageId, thread };
  }

  const threadOf = async (pageId: string) => (await instance.admin.json<Thread[]>(`/api/pages/${pageId}/threads`))[0];
  const startAgent = async (projectId: string) => {
    const { token } = await instance.ariane.json<AgentTokenResponse>("/api/agent-token");
    agent = await instance.connectAgent(token, { projectIds: [projectId] });
    await agent.hello;
  };

  it("lets only the account that took the thread release it", async () => {
    const { pageId, thread } = await setup();

    expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/release`)).status).toBe(409);
    expect(await threadOf(pageId)).toMatchObject({ take: { person: { name: "Thomas Lefevre" } } });

    expect((await instance.thomas.send("POST", `/api/threads/${thread.id}/release`)).status).toBe(200);
    expect(await threadOf(pageId)).toMatchObject({ toTake: true });
  });

  it("asks before handing over a thread taken by someone else, then records who took it and who handed it over", async () => {
    const { project, pageId, thread } = await setup();
    await startAgent(project.id);

    const refused = await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "taken", take: { person: { name: "Thomas Lefevre" }, folder: "~/site" } });
    expect(await threadOf(pageId)).toMatchObject({ take: { person: { name: "Thomas Lefevre" } } });

    expect((await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true })).status).toBe(200);
    const after = await threadOf(pageId);
    expect(after).not.toHaveProperty("take");
    expect(after.traces).toMatchObject([{ kind: "handed-over", taker: { name: "Thomas Lefevre" }, by: { name: "Ariane Martin" } }]);
  });

  it("keeps a handed-over thread's late reply from the conversation that took it, signed", async () => {
    const { project, pageId, thread } = await setup();
    await startAgent(project.id);
    await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true });
    const { token } = await instance.thomas.json<AgentTokenResponse>("/api/agent-token");

    const late = await fetch(`${instance.server.url}${AGENT_API_PREFIX}/threads/${thread.id}/replies`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ body: "Done", terminalSessionId: SESSION }) });

    expect(late.status).toBe(201);
    expect(await threadOf(pageId)).toMatchObject({ replies: [{ author: "claude", late: "handed-over" }] });
    expect(await threadOf(pageId)).not.toHaveProperty("take");
  });

  it("refuses a member with Commentaire, and answers 409 when no agent runs", async () => {
    const { thread } = await setup();

    expect((await instance.marc.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true })).status).toBe(403);
    const noAgent = await instance.ariane.send("POST", `/api/threads/${thread.id}/hand-over`, { confirm: true });
    expect(noAgent.status).toBe(409);
    expect(await noAgent.json()).toMatchObject({ code: "no-agent" });
  });
});
