import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentCheckout, type AgentTokenResponse, type Page, type PageGaps, type PageVersionSummary, type Project, type Thread } from "@redline/shared";
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
    body: { files: { "home.html": "<h1>Bye</h1>" }, message: "Change", origin: "thread", baseVersionId: checkout.versionId },
  });
  expect(res.status).toBe(201);
  expect((await server.get(`/api/pages/${page.id}/files/home.html`)).status).toBe(200);
  expect(await (await server.get(`/api/pages/${page.id}/files/home.html`)).text()).toBe("<h1>Bye</h1>");
});

it("tells the agent the gaps of what it publishes, and of a working copy before publishing", async () => {
  const checkout = (await (await agentCall(`/pages/${page.id}/files`)).json()) as AgentCheckout;
  const files = { "home.html": '<h1 style="color: #2563eb">Hi</h1><p data-ds-libre style="color: #ea580c">free</p>' };

  const check = await agentCall(`/pages/${page.id}/gaps`, { method: "POST", body: { files } });
  expect(check.status).toBe(200);
  expect(((await check.json()) as PageGaps).gaps.map((g) => [g.file, g.kind, g.value])).toEqual([["home.html", "color", "#2563eb"]]);

  const res = await agentCall(`/pages/${page.id}/versions`, { method: "POST", body: { files, message: "Blue", origin: "terminal", baseVersionId: checkout.versionId } });
  expect(((await res.json()) as PageVersionSummary).gaps?.map((g) => g.value)).toEqual(["#2563eb"]);
  expect((await agentCall(`/pages/nope/gaps`, { method: "POST", body: { files } })).status).toBe(404);
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

it("lets an agent upload a project asset through a page, which every artboard of the project then reaches", async () => {
  const bytes = Buffer.from([0, 255, 128, 7]);
  const upload = (name: string, body: Buffer, auth = token) =>
    fetch(`${server.url}${AGENT_API_PREFIX}/pages/${page.id}/assets/${name}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${auth}`, "content-type": "image/jpeg" },
      body,
    });

  const res = await upload("photos/hero.jpg", bytes);
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ name: "photos/hero.jpg", size: 4 });
  const served = await fetch(`${server.artboardOrigin}/pages/${page.id}/assets/photos/hero.jpg`);
  expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  const assets = (await (await server.get(`/api/projects/${page.projectId}/assets`)).json()) as { name: string }[];
  expect(assets.map((a) => a.name)).toEqual(["photos/hero.jpg"]);

  expect((await upload("x.jpg", bytes, "abt_wrong")).status).toBe(401);
  expect((await upload("..%2Fescape.jpg", bytes)).status).toBe(400);
  const unknown = "00000000-0000-4000-8000-000000000000";
  expect(
    (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${unknown}/assets/x.jpg`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: bytes })).status,
  ).toBe(404);
  // The server answers 413 before the client has sent everything, which a client may see as a broken pipe.
  await upload("huge.jpg", Buffer.alloc(20 * 1024 * 1024 + 1)).then((r) => expect(r.status).toBe(413), () => undefined);
  const after = (await (await server.get(`/api/projects/${page.projectId}/assets`)).json()) as { name: string }[];
  expect(after.map((a) => a.name)).toEqual(["photos/hero.jpg"]);
});

it("lets an agent list projects and their pages, and create both", async () => {
  const spooky = (await (await server.post("/api/design-systems", { title: "Spooky" })).json()) as { id: string };
  const created = await agentCall("/projects", { method: "POST", body: { title: "Halloween", designSystem: spooky.id } });
  expect(created.status).toBe(201);
  const project = (await created.json()) as Project;
  expect(project).toMatchObject({ title: "Halloween", designSystem: spooky.id });

  const pageRes = await agentCall(`/projects/${project.id}/pages`, { method: "POST", body: { title: "  Stories  " } });
  expect(pageRes.status).toBe(201);
  const stories = (await pageRes.json()) as Page;
  expect(stories).toMatchObject({ projectId: project.id, title: "Stories", createdBy: "claude" });
  expect(Object.keys(stories.version.files)).toEqual(["manifest.json"]);
  const manifest = await (await server.get(`/api/pages/${stories.id}/files/manifest.json`)).json();
  expect(manifest).toMatchObject({ designSystem: spooky.id, artboards: [] });

  const pages = (await (await agentCall(`/projects/${project.id}/pages`)).json()) as Page[];
  expect(pages.map((p) => p.title)).toEqual(["Stories"]);

  expect((await agentCall(`/projects/nope/pages`)).status).toBe(404);
  expect((await agentCall(`/projects/nope/pages`, { method: "POST", body: { title: "X" } })).status).toBe(404);
  expect((await agentCall(`/projects/${project.id}/pages`, { method: "POST", body: {} })).status).toBe(400);
  expect((await agentCall(`/projects/${project.id}/pages`, { method: "POST", body: { title: "x".repeat(500) } })).status).toBe(400);
  expect((await agentCall("/projects", { method: "POST", body: { title: "Y", designSystem: 3 } })).status).toBe(400);
  expect((await agentCall("/projects", { method: "POST", body: { title: "Y", designSystem: "material" } })).status).toBe(400);
  expect(((await (await agentCall("/projects", { method: "POST", body: { title: "Z", designSystem: "" } })).json()) as Project).designSystem).toBeNull();

  // A design system's own project holds only its design system page.
  expect((await agentCall(`/projects/${spooky.id}/pages`)).status).toBe(404);
  expect((await agentCall(`/projects/${spooky.id}/pages`, { method: "POST", body: { title: "X" } })).status).toBe(404);
});

it("accepts a publish of several MB, and explains a page too heavy instead of answering Payload Too Large", async () => {
  const checkout = (await (await agentCall(`/pages/${page.id}/files`)).json()) as AgentCheckout;
  const publish = (html: string) =>
    agentCall(`/pages/${page.id}/versions`, {
      method: "POST",
      body: { files: { "home.html": html }, message: "Big", origin: "terminal", baseVersionId: checkout.versionId },
    });

  expect((await publish("x".repeat(3 * 1024 * 1024))).status).toBe(201);

  const tooBig = await publish("x".repeat(11 * 1024 * 1024));
  expect(tooBig.status).toBe(413);
  expect(((await tooBig.json()) as { error: string }).error).toMatch(/10 MB.*assets\//);
});

it("refuses an agent version whose elements lack ids, naming each one, while the user's own API stays lenient", async () => {
  const checkout = (await (await agentCall(`/pages/${page.id}/files`)).json()) as AgentCheckout;
  const manifest = JSON.stringify({ artboards: [{ file: "home.html" }], elements: [{ kind: "text", text: "a", id: "a" }, { kind: "sticky", text: "b" }, { kind: "arrow", from: "home.html", to: "a" }] });
  const publish = (manifestText: string) =>
    agentCall(`/pages/${page.id}/versions`, {
      method: "POST",
      body: { files: { "home.html": "<h1>Hi</h1>", "manifest.json": manifestText }, message: "m", origin: "thread", baseVersionId: checkout.versionId },
    });

  const refused = await publish(manifest);
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toBe("elements[1] (sticky) has no id; elements[2] (arrow) has no id");

  const legacy = await publish(JSON.stringify({ artboards: [{ file: "home.html" }], notes: [{ text: "old" }] }));
  expect(legacy.status).toBe(400);
  expect(((await legacy.json()) as { error: string }).error).toBe("notes is legacy: move these titles to elements, each with an id");

  const duplicate = await publish(JSON.stringify({ artboards: [{ file: "home.html" }], elements: [{ kind: "text", text: "a", id: "x" }, { kind: "text", text: "b", id: "x" }] }));
  expect(duplicate.status).toBe(400);
  const clash = await publish(JSON.stringify({ artboards: [{ file: "home.html" }], elements: [{ kind: "text", text: "a", id: "home.html" }] }));
  expect(clash.status).toBe(400);

  const lenient = await server.post(`/api/pages/${page.id}/versions`, { files: { "home.html": "<h1>Hi</h1>", "manifest.json": manifest }, message: "m", origin: "tweak" });
  expect(lenient.status).toBe(201);
});
