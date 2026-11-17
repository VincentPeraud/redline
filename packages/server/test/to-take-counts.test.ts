import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse, type Page, type Thread } from "@redline/shared";
import { AccountsInstance } from "./accounts-harness.js";

const SESSION = "7d1f1d1e-3c0a-4d6e-9a43-5b8d3c1a2f10";

describe("the page list counts the threads to take", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const post = async (pageId: string, body: string) =>
    (await (await instance.admin.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;
  const counts = async (projectId: string) =>
    (await instance.admin.json<Page[]>(`/api/projects/${projectId}/pages`)).map((page) => ({ title: page.title, open: page.openThreadCount, toTake: page.toTakeCount }));

  it("counts only threads nobody handles, in Conversation mode", async () => {
    const project = await instance.createProject(instance.admin);
    const waiting = await instance.createPage(instance.admin, project.id, "Waiting", "conversation");
    const agentPage = await instance.createPage(instance.admin, project.id, "Agent", "agent");
    await instance.createPage(instance.admin, project.id, "Quiet", "conversation");
    await post(waiting, "One");
    const second = await post(waiting, "Two");
    await post(waiting, "Three");
    await post(agentPage, "For the agent");

    expect(await counts(project.id)).toEqual([
      { title: "Waiting", open: 3, toTake: 3 },
      { title: "Agent", open: 1, toTake: 0 },
      { title: "Quiet", open: 0, toTake: 0 },
    ]);

    await instance.admin.send("POST", `/api/threads/${second.id}/resolve`, {});
    expect((await counts(project.id))[0]).toEqual({ title: "Waiting", open: 2, toTake: 2 });

    // A take, even by a conversation of another folder, leaves the counter; the thread stays open.
    const { token } = await instance.admin.json<AgentTokenResponse>("/api/agent-token");
    const call = (path: string, body: unknown) =>
      fetch(instance.server.url + AGENT_API_PREFIX + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    await call(`/terminal-sessions/${SESSION}/heartbeat`, { folder: "/Users/ana/crm", machine: "MacBook-Air" });
    await call(`/terminal-sessions/${SESSION}/take`, { pageId: waiting });
    expect((await counts(project.id))[0]).toEqual({ title: "Waiting", open: 2, toTake: 0 });
  });
});
