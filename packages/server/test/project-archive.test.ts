import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, type DesignSystem, type DesignSystemSummary, type Page, type Project, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("archiving and deleting projects and design systems", () => {
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
  const createProject = (title: string, designSystem?: string) => json<Project>(server.post("/api/projects", { title, ...(designSystem ? { designSystem } : {}) }));
  const createPage = (projectId: string) => json<Page>(server.post(`/api/projects/${projectId}/pages`, { title: "Home", files: { "home.html": "<h1>Home</h1>" } }));
  const pin = (pageId: string) => server.post(`/api/pages/${pageId}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body: "Make it blue" });
  const agentApi = async (path: string) => {
    const { token } = await json<{ token: string }>(server.get("/api/agent-token"));
    return fetch(server.url + AGENT_API_PREFIX + path, { headers: { authorization: `Bearer ${token}` } });
  };

  it("moves an archived project out of the project list into the archived one, and back when unarchived", async () => {
    const acme = await createProject("Acme");
    const other = await createProject("Other");

    expect((await server.post(`/api/projects/${acme.id}/archive`, {})).status).toBe(200);
    expect((await json<Project[]>(server.get("/api/projects"))).map((p) => p.title)).toEqual(["Other"]);
    const archived = await json<Project[]>(server.get("/api/projects?archived=1"));
    expect(archived.map((p) => p.title)).toEqual(["Acme"]);
    expect(archived[0].archivedAt).toEqual(expect.any(String));
    expect((await json<Project>(server.get(`/api/projects/${acme.id}`))).archivedAt).toEqual(expect.any(String));

    expect((await server.post(`/api/projects/${acme.id}/unarchive`, {})).status).toBe(200);
    expect((await json<Project[]>(server.get("/api/projects"))).map((p) => p.id)).toEqual([acme.id, other.id]);
    expect((await json<Project>(server.get(`/api/projects/${acme.id}`))).archivedAt).toBeUndefined();
  });

  it("keeps an archived project readable but refuses every change to it, from the UI and from sessions", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    const thread = await json<Thread>(pin(page.id));
    await server.post(`/api/projects/${acme.id}/archive`, {});

    expect((await server.get(`/api/pages/${page.id}`)).status).toBe(200);
    expect((await json<Thread[]>(server.get(`/api/pages/${page.id}/threads`))).map((t) => t.id)).toEqual([thread.id]);

    const refused = [
      await pin(page.id),
      await server.post(`/api/threads/${thread.id}/messages`, { body: "And bigger" }),
      await send("PATCH", `/api/projects/${acme.id}`, { title: "Renamed" }),
      await send("PATCH", `/api/pages/${page.id}`, { title: "Renamed" }),
      await server.post(`/api/projects/${acme.id}/pages`, { title: "New", files: {} }),
      await server.post(`/api/pages/${page.id}/conversations`, { body: "Hi" }),
    ];
    for (const [index, res] of refused.entries()) {
      expect([index, res.status]).toEqual([index, 409]);
      expect(((await res.json()) as { error: string }).error).toMatch(/archived/);
    }
    const { token } = await json<{ token: string }>(server.get("/api/agent-token"));
    const publish = await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${page.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files: { "home.html": "<h1>Changed</h1>" }, message: "Change" }),
    });
    expect(publish.status).toBe(409);
    expect(((await publish.json()) as { error: string }).error).toMatch(/archived/);
  });

  it("hides archived projects and design systems from sessions", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Old DS" }));
    const acme = await createProject("Acme");
    await createProject("Other");
    await server.post(`/api/projects/${acme.id}/archive`, {});
    await server.post(`/api/projects/${ds.id}/archive`, {});

    expect((await json<Project[]>(agentApi("/projects"))).map((p) => p.title)).toEqual(["Other"]);
    expect((await json<DesignSystem[]>(agentApi("/design-systems"))).map((d) => d.title)).not.toContain("Old DS");
    expect((await agentApi(`/projects/${acme.id}/pages`)).status).toBe(404);
  });

  it("refuses to archive a project while an agent works on it", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    await pin(page.id);
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    const work = agent.messages.find((m) => m.type === "work");
    expect(work).toBeDefined();

    expect(await json(server.get(`/api/projects/${acme.id}/archive`))).toMatchObject({ refusal: { reason: "busy" } });
    const busy = await server.post(`/api/projects/${acme.id}/archive`, {});
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ reason: "busy" });

    agent.send({ type: "work-done", workId: (work as { item: { id: string } }).item.id });
    for (let i = 0; i < 100 && (await server.post(`/api/projects/${acme.id}/archive`, {})).status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await json<Project>(server.get(`/api/projects/${acme.id}`))).archivedAt).toEqual(expect.any(String));
  });

  it("refuses to archive a design system any project follows, archived ones included", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Lumora DS" }));
    const follower = await createProject("Halloween", ds.id);
    await server.post(`/api/projects/${follower.id}/archive`, {});

    expect(await json(server.get(`/api/projects/${ds.id}/archive`))).toMatchObject({ refusal: { reason: "followed", projects: [{ id: follower.id, title: "Halloween", archived: true }] } });
    const followed = await server.post(`/api/projects/${ds.id}/archive`, {});
    expect(followed.status).toBe(409);
    expect(await followed.json()).toMatchObject({ reason: "followed" });

    await send("DELETE", `/api/projects/${follower.id}`, { title: "Halloween" });
    expect(await json(server.get(`/api/projects/${ds.id}/archive`))).toEqual({});
    expect((await server.post(`/api/projects/${ds.id}/archive`, {})).status).toBe(200);
    expect((await json<DesignSystemSummary[]>(server.get("/api/design-systems"))).map((d) => d.title)).not.toContain("Lumora DS");
    const archived = await json<DesignSystemSummary[]>(server.get("/api/design-systems?archived=1"));
    expect(archived.map((d) => d.title)).toEqual(["Lumora DS"]);
    expect(archived[0].archivedAt).toEqual(expect.any(String));
  });

  it("lists the projects following a design system with the archived ones marked", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Lumora DS" }));
    await createProject("Live", ds.id);
    const old = await createProject("Old", ds.id);
    await server.post(`/api/projects/${old.id}/archive`, {});

    const summary = (await json<DesignSystemSummary[]>(server.get("/api/design-systems"))).find((d) => d.id === ds.id)!;
    expect(summary.usedBy).toEqual([
      { id: expect.any(String), title: "Live" },
      { id: old.id, title: "Old", archived: true },
    ]);
  });

  it("does not let a project choose an archived design system", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Old DS" }));
    await server.post(`/api/projects/${ds.id}/archive`, {});
    expect((await server.post("/api/projects", { title: "New", designSystem: ds.id })).status).toBe(400);
    const acme = await createProject("Acme");
    expect((await send("PUT", `/api/projects/${acme.id}/design-system`, { designSystem: ds.id })).status).toBe(400);
  });

  it("deletes only an archived project, with its pages and threads", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    await pin(page.id);

    expect((await send("DELETE", `/api/projects/${acme.id}`, { title: "Acme" })).status).toBe(409);
    await server.post(`/api/projects/${acme.id}/archive`, {});
    expect((await send("DELETE", `/api/projects/${acme.id}`)).status).toBe(400);
    expect((await send("DELETE", `/api/projects/${acme.id}`, { title: "acme" })).status).toBe(400);
    expect((await send("DELETE", `/api/projects/${acme.id}`, { title: "Acme" })).status).toBe(204);

    expect((await server.get(`/api/projects/${acme.id}`)).status).toBe(404);
    expect((await server.get(`/api/pages/${page.id}`)).status).toBe(404);
    expect(await json<Project[]>(server.get("/api/projects?archived=1"))).toEqual([]);
    expect((await send("DELETE", `/api/projects/${acme.id}`, { title: "Acme" })).status).toBe(404);
  });

  it("deletes an archived design system", async () => {
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Old DS" }));
    await server.post(`/api/projects/${ds.id}/archive`, {});
    expect((await send("DELETE", `/api/projects/${ds.id}`, { title: "Old DS" })).status).toBe(204);
    expect((await server.get(`/api/design-systems/${ds.id}`)).status).toBe(404);
    expect(await json<DesignSystemSummary[]>(server.get("/api/design-systems?archived=1"))).toEqual([]);
  });

  it("keeps a comment waiting for an offline agent queued while archived, and sends it once unarchived", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    await pin(page.id);
    expect((await server.post(`/api/projects/${acme.id}/archive`, {})).status).toBe(200);

    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    await new Promise((r) => setTimeout(r, 150));
    expect(agent.messages.some((m) => m.type === "work")).toBe(false);

    await server.post(`/api/projects/${acme.id}/unarchive`, {});
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(agent.messages.some((m) => m.type === "work")).toBe(true);
  });

  it("labels a comment waiting on an archived project as such, and keeps an archived follower's agent away from the design system's work", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    await pin(page.id);
    await server.post(`/api/projects/${acme.id}/archive`, {});
    expect(await json(server.get(`/api/pages/${page.id}/queue`))).toMatchObject([{ reason: "project-archived" }]);

    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "DS" }));
    const old = await createProject("Old", ds.id);
    await server.post(`/api/projects/${old.id}/archive`, {});
    const agent = await server.connectAgent({ projectId: old.id });
    await agent.hello;
    const [dsPage] = await json<Page[]>(server.get(`/api/projects/${ds.id}/pages`));
    await server.post(`/api/pages/${dsPage!.id}/threads`, { artboard: "index.html", selector: "h1", xPct: 10, yPct: 10, body: "Darker" });
    await new Promise((r) => setTimeout(r, 150));
    expect(agent.messages.some((m) => m.type === "work")).toBe(false);
  });

  it("refuses to create a design system from an archived project's pages", async () => {
    const acme = await createProject("Acme");
    await server.post(`/api/projects/${acme.id}/archive`, {});
    expect((await server.post("/api/design-systems", { title: "From Acme", fromProjectId: acme.id })).status).toBe(409);
  });

  const agentPost = async (path: string, body: unknown = {}) => {
    const { token } = await json<{ token: string }>(server.get("/api/agent-token"));
    return fetch(server.url + AGENT_API_PREFIX + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  };

  it("lets terminal mode rename a project or a design system, but not an archived one, the neutral one or an unknown id", async () => {
    const acme = await createProject("Acme");
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Lumora DS" }));

    expect(await json(agentPost(`/projects/${acme.id}/rename`, { title: "  Acme v2 " }))).toMatchObject({ id: acme.id, title: "Acme v2", isDesignSystem: false });
    expect((await json<Project>(server.get(`/api/projects/${acme.id}`))).title).toBe("Acme v2");
    expect(await json(agentPost(`/projects/${ds.id}/rename`, { title: "Lumora DS v2" }))).toMatchObject({ id: ds.id, title: "Lumora DS v2", isDesignSystem: true });
    expect((await json<DesignSystemSummary[]>(server.get("/api/design-systems"))).map((d) => d.title)).toContain("Lumora DS v2");

    expect((await agentPost(`/projects/${acme.id}/rename`, { title: "  " })).status).toBe(400);
    expect((await agentPost("/projects/nope/rename", { title: "X" })).status).toBe(404);
    expect((await agentPost("/projects/neutral/rename", { title: "X" })).status).toBe(404);
    await server.post(`/api/projects/${acme.id}/archive`, {});
    const archived = await agentPost(`/projects/${acme.id}/rename`, { title: "Acme v3" });
    expect(archived.status).toBe(409);
    expect(((await archived.json()) as { error: string }).error).toMatch(/archived/);
  });

  it("lets terminal mode archive a project or a design system, with the web's refusals", async () => {
    const acme = await createProject("Acme");
    const ds = await json<DesignSystem>(server.post("/api/design-systems", { title: "Lumora DS" }));
    const follower = await createProject("Halloween", ds.id);

    const followed = await agentPost(`/projects/${ds.id}/archive`);
    expect(followed.status).toBe(409);
    expect(await followed.json()).toMatchObject({ reason: "followed", projects: [{ id: follower.id, title: "Halloween" }], error: expect.stringContaining("(Halloween)") });
    await server.post(`/api/projects/${follower.id}/archive`, {});
    expect(((await (await agentPost(`/projects/${ds.id}/archive`)).json()) as { error: string }).error).toMatch(/Halloween \(archived: unarchive it in Redline first\)/);

    expect(await json(agentPost(`/projects/${acme.id}/archive`))).toMatchObject({ id: acme.id, archivedAt: expect.any(String) });
    expect((await agentPost(`/projects/${acme.id}/archive`)).status).toBe(200);
    expect((await agentPost("/projects/nope/archive")).status).toBe(404);
    expect((await agentPost("/projects/neutral/archive")).status).toBe(404);
  });

  it("refuses a terminal archive of a project while an agent works on it", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id);
    const agent = await server.connectAgent({ projectId: acme.id });
    await agent.hello;
    await pin(page.id);
    for (let i = 0; i < 100 && !agent.messages.some((m) => m.type === "work"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(agent.messages.some((m) => m.type === "work")).toBe(true);

    const busy = await agentPost(`/projects/${acme.id}/archive`);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ reason: "busy" });
  });

  it("survives a restart archived", async () => {
    const acme = await createProject("Acme");
    await server.post(`/api/projects/${acme.id}/archive`, {});
    await server.restart();
    expect((await json<Project[]>(server.get("/api/projects?archived=1"))).map((p) => p.id)).toEqual([acme.id]);
  });
});
