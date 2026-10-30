import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type DesignSystem, type HomeOverview, type Page, type Project, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("archiving and deleting pages", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(server.url + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
  const createProject = (title: string) => json<Project>(server.post("/api/projects", { title }));
  const createPage = (projectId: string, title = "Home") => json<Page>(server.post(`/api/projects/${projectId}/pages`, { title, files: { "home.html": `<h1>${title}</h1>` } }));
  const pin = (pageId: string) => server.post(`/api/pages/${pageId}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "Make it blue" });
  const titles = async (path: string) => (await json<Page[]>(server.get(path))).map((page) => page.title);
  const agentSend = async (method: string, path: string, body?: unknown) => {
    const { token } = await json<{ token: string }>(server.get("/api/agent-token"));
    return fetch(server.url + AGENT_API_PREFIX + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  it("moves an archived page out of the project's pages into its archived ones, and back when unarchived", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id, "Home");
    await createPage(acme.id, "Signup");

    const archived = await server.post(`/api/pages/${home.id}/archive`, {});
    expect(archived.status).toBe(200);
    expect((await archived.json()) as Page).toMatchObject({ id: home.id, archivedAt: expect.any(String) });
    expect(await titles(`/api/projects/${acme.id}/pages`)).toEqual(["Signup"]);
    expect(await titles(`/api/projects/${acme.id}/pages?archived=1`)).toEqual(["Home"]);
    expect((await json<Page>(server.get(`/api/pages/${home.id}`))).archivedAt).toEqual(expect.any(String));

    expect((await server.post(`/api/pages/${home.id}/unarchive`, {})).status).toBe(200);
    expect(await titles(`/api/projects/${acme.id}/pages`)).toEqual(["Home", "Signup"]);
    expect(await titles(`/api/projects/${acme.id}/pages?archived=1`)).toEqual([]);
    expect((await json<Page>(server.get(`/api/pages/${home.id}`))).archivedAt).toBeUndefined();
  });

  it("keeps an archived page readable but refuses every change to it, while the project's other pages stay writable", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id, "Home");
    const signup = await createPage(acme.id, "Signup");
    const thread = await json<Thread>(pin(home.id));
    await server.post(`/api/pages/${home.id}/archive`, {});

    expect((await server.get(`/api/pages/${home.id}`)).status).toBe(200);
    expect((await json<Thread[]>(server.get(`/api/pages/${home.id}/threads`))).map((t) => t.id)).toEqual([thread.id]);
    const refused = [
      await pin(home.id),
      await server.post(`/api/threads/${thread.id}/messages`, { body: "And bigger" }),
      await send("PATCH", `/api/pages/${home.id}`, { title: "Renamed" }),
      await server.post(`/api/pages/${home.id}/conversations`, { body: "Hi" }),
      await agentSend("POST", `/pages/${home.id}/versions`, { files: { "home.html": "<h1>Changed</h1>" }, message: "Change" }),
    ];
    for (const [index, res] of refused.entries()) {
      expect([index, res.status]).toEqual([index, 409]);
      expect(((await res.json()) as { error: string }).error).toMatch(/page is archived/);
    }
    expect((await pin(signup.id)).status).toBe(201);
  });

  it("hides an archived page from sessions and from the home screen", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id, "Home");
    await createPage(acme.id, "Signup");
    await server.post(`/api/pages/${home.id}/archive`, {});

    expect((await json<Page[]>(agentSend("GET", `/projects/${acme.id}/pages`))).map((p) => p.title)).toEqual(["Signup"]);
    const homeData = await json<HomeOverview>(server.get("/api/home"));
    expect(JSON.stringify(homeData)).not.toContain(home.id);
  });

  it("lets a session archive a page of its project, never one of another project; terminal mode archives any active page", async () => {
    const acme = await createProject("Acme");
    const other = await createProject("Other");
    const home = await createPage(acme.id, "Home");
    const old = await createPage(acme.id, "Old");
    const foreign = await createPage(other.id, "Foreign");
    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    await pin(home.id);
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    const workId = (agent.messages.find((m) => m.type === "work") as { item: { id: string } }).item.id;

    const mine = await agentSend("POST", `/pages/${old.id}/archive`, { workId });
    expect(mine.status).toBe(200);
    expect((await mine.json()) as Page).toMatchObject({ archivedAt: expect.any(String) });
    expect((await agentSend("POST", `/pages/${foreign.id}/archive`, { workId })).status).toBe(403);
    const own = await agentSend("POST", `/pages/${home.id}/archive`, { workId });
    expect(own.status).toBe(409);
    expect(((await own.json()) as { error: string }).error).toMatch(/working on this page/);

    expect((await agentSend("POST", `/pages/${foreign.id}/archive`, {})).status).toBe(200);
    expect(await titles(`/api/projects/${other.id}/pages?archived=1`)).toEqual(["Foreign"]);
  });

  it("refuses to archive a page while an agent works on it, and says why beforehand", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id);
    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    expect(await json(server.get(`/api/pages/${home.id}/archive`))).toEqual({});
    await pin(home.id);
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    const work = agent.messages.find((m) => m.type === "work") as { item: { id: string } };

    expect(await json(server.get(`/api/pages/${home.id}/archive`))).toMatchObject({ refusal: { reason: "busy" } });
    expect((await server.post(`/api/pages/${home.id}/archive`, {})).status).toBe(409);

    agent.send({ type: "work-done", workId: work.item.id });
    for (let i = 0; i < 100 && (await server.post(`/api/pages/${home.id}/archive`, {})).status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await json<Page>(server.get(`/api/pages/${home.id}`))).archivedAt).toEqual(expect.any(String));
  });

  it("keeps a comment waiting on a page archived meanwhile queued, labelled, and sends it once unarchived", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id);
    await pin(home.id);
    expect((await server.post(`/api/pages/${home.id}/archive`, {})).status).toBe(200);
    expect(await json(server.get(`/api/pages/${home.id}/queue`))).toMatchObject([{ reason: "page-archived" }]);

    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    await new Promise((r) => setTimeout(r, 150));
    expect(agent.messages.some((m) => m.type === "work")).toBe(false);

    await server.post(`/api/pages/${home.id}/unarchive`, {});
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(agent.messages.some((m) => m.type === "work")).toBe(true);
  });

  it("does not archive a design system's page", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "DS" }));
    const [dsPage] = await json<Page[]>(server.get(`/api/projects/${ds.id}/pages`));
    expect((await server.post(`/api/pages/${dsPage!.id}/archive`, {})).status).toBe(400);
    expect((await agentSend("POST", `/pages/${dsPage!.id}/archive`, {})).status).toBe(400);
  });

  it("deletes only an archived page, given its exact title, with its threads and versions", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id, "Home");
    const signup = await createPage(acme.id, "Signup");
    await pin(home.id);

    expect((await send("DELETE", `/api/pages/${home.id}`, { title: "Home" })).status).toBe(409);
    await server.post(`/api/pages/${home.id}/archive`, {});
    expect((await send("DELETE", `/api/pages/${home.id}`)).status).toBe(400);
    expect((await send("DELETE", `/api/pages/${home.id}`, { title: "home" })).status).toBe(400);
    expect((await agentSend("DELETE", `/pages/${home.id}`, { title: "Home" })).status).toBe(404);
    expect((await send("DELETE", `/api/pages/${home.id}`, { title: "Home" })).status).toBe(204);

    expect((await server.get(`/api/pages/${home.id}`)).status).toBe(404);
    expect(await titles(`/api/projects/${acme.id}/pages?archived=1`)).toEqual([]);
    expect(await titles(`/api/projects/${acme.id}/pages`)).toEqual(["Signup"]);
    expect((await server.get(`/api/pages/${signup.id}`)).status).toBe(200);
    expect((await send("DELETE", `/api/pages/${home.id}`, { title: "Home" })).status).toBe(404);
  });

  it("survives a restart archived", async () => {
    const acme = await createProject("Acme");
    const home = await createPage(acme.id);
    await server.post(`/api/pages/${home.id}/archive`, {});
    await server.restart();
    expect(await titles(`/api/projects/${acme.id}/pages?archived=1`)).toEqual(["Home"]);
  });
});
