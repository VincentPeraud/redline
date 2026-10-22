import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentCheckout, type AgentTokenResponse, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const UNSAFE = ["../x.html", "..\\..\\.mcp.json", "a\\b.html", "C:/x.html", "c:x.html", "/abs.html", "a//b.html", "./a.html", "a/./b.html", "a/../b.html", "", "a\0b.html", "a.html:stream"];

describe("file paths of pages", () => {
  let server: TestServer;
  let projectId: string;
  let page: Page;
  let token: string;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    projectId = ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
    page = (await (
      await server.post(`/api/projects/${projectId}/pages`, { title: "Home", type: "prototype", files: { "home.html": "<h1>Hi</h1>" } })
    ).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const agentPublish = (files: Record<string, string>) =>
    fetch(server.url + `${AGENT_API_PREFIX}/pages/${page.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files, message: "x", origin: "thread", baseVersionId: page.version.id }),
    });

  it.each(UNSAFE)("refuses %j in a new page, a published version and an agent's publish", async (path) => {
    const files = { "home.html": "<h1>Hi</h1>", [path]: "x" };
    expect((await server.post(`/api/projects/${projectId}/pages`, { title: "Bad", type: "prototype", files })).status).toBe(400);
    expect((await server.post(`/api/pages/${page.id}/versions`, { files, message: "x", origin: "thread" })).status).toBe(400);
    expect((await agentPublish(files)).status).toBe(400);
  });

  it("accepts nested relative paths", async () => {
    const files = { "home.html": "<h1>Hi</h1>", "assets/img/logo.svg": "<svg/>" };
    expect((await server.post(`/api/pages/${page.id}/versions`, { files, message: "x", origin: "thread" })).status).toBe(201);
    expect((await agentPublish({ ...files, "b/c.html": "y" })).status).toBe(201);
  });

  it("rejects an invalid tweaks.json published by a session, like the web API does", async () => {
    const files = { "home.html": "<h1>Hi</h1>", "tweaks.json": "[1, 2]" };
    expect((await server.post(`/api/pages/${page.id}/versions`, { files, message: "x", origin: "thread" })).status).toBe(400);
    expect((await agentPublish(files)).status).toBe(400);
  });

  it("keeps serving the checkout of a page", async () => {
    const res = await fetch(server.url + `${AGENT_API_PREFIX}/pages/${page.id}/files`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await res.json()) as AgentCheckout).files).toEqual({ "home.html": "<h1>Hi</h1>" });
  });
});
