import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentCheckout, type AgentTokenResponse, type Page, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let token: string;
let page: Page;

beforeEach(async () => {
  server = await startTestServer();
  token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Home",
      type: "prototype",
      files: { "home.html": "<h1>Hi</h1>" },
    })
  ).json()) as Page;
});
afterEach(async () => {
  await server.stop();
});

function agentCall(path: string, init: { method?: string; token?: string; body?: unknown } = {}) {
  return fetch(server.url + AGENT_API_PREFIX + path, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${init.token ?? token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

it("refuses agent API calls without the agent token", async () => {
  expect((await agentCall(`/pages/${page.id}/files`, { token: "abt_wrong" })).status).toBe(401);
  expect((await fetch(server.url + `${AGENT_API_PREFIX}/pages/${page.id}/files`)).status).toBe(401);
});

it("lets an agent check out a page's files and publish a version", async () => {
  const checkout = (await (await agentCall(`/pages/${page.id}/files`)).json()) as AgentCheckout;
  expect(checkout.files).toEqual({ "home.html": "<h1>Hi</h1>" });

  const res = await agentCall(`/pages/${page.id}/versions`, {
    method: "POST",
    body: { files: { "home.html": "<h1>Bye</h1>" }, message: "Change", origin: "thread" },
  });
  expect(res.status).toBe(201);
  expect((await server.get(`/api/pages/${page.id}/files/home.html`)).status).toBe(200);
  expect(await (await server.get(`/api/pages/${page.id}/files/home.html`)).text()).toBe("<h1>Bye</h1>");
});

it("records an agent's reply in the thread", async () => {
  const thread = (await (
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 1, yPct: 2, body: "Hi?" })
  ).json()) as Thread;

  const res = await agentCall(`/threads/${thread.id}/replies`, { method: "POST", body: { body: "Hello" } });
  expect(res.status).toBe(201);
  const threads = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  expect(threads[0].replies.map((r) => r.body)).toEqual(["Hello"]);

  expect((await agentCall(`/threads/nope/replies`, { method: "POST", body: { body: "x" } })).status).toBe(404);
});
