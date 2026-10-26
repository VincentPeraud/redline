import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { starterPageFiles, type HomeOverview, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

describe("home overview", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function home() {
    return (await (await server.get("/api/home")).json()) as HomeOverview;
  }

  async function createProject(title: string) {
    return (await (await server.post("/api/projects", { title })).json()) as Project;
  }

  async function createPage(projectId: string, title: string) {
    const files = starterPageFiles(title, null);
    return (await (await server.post(`/api/projects/${projectId}/pages`, { title, files })).json()) as Page;
  }

  it("lists the most recently changed pages first, with their project", async () => {
    const acme = await createProject("Acme");
    const first = await createPage(acme.id, "First");
    await createPage(acme.id, "Second");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await server.post(`/api/pages/${first.id}/versions`, { files: starterPageFiles("First again", null), message: "edit", origin: "terminal" });
    const overview = await home();
    expect(overview.projectCount).toBe(1);
    expect(overview.recentPages.map((r) => [r.page.title, r.projectTitle])).toEqual([
      ["First", "Acme"],
      ["Second", "Acme"],
    ]);
  });

  it("summarises each project: pages, open threads and last change", async () => {
    const acme = await createProject("Acme");
    const empty = await createProject("Empty");
    const page = await createPage(acme.id, "Landing");
    await createPage(acme.id, "Pricing");
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "h1", xPct: 1, yPct: 1, body: "Bigger", held: true });
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "p", xPct: 2, yPct: 2, body: "Smaller", held: true });
    const { projects } = await home();
    expect(projects.find((p) => p.id === acme.id)).toMatchObject({ title: "Acme", pageCount: 2, openThreads: 0, waitingThreads: 0 });
    expect(projects.find((p) => p.id === acme.id)?.updatedAt).toBeTruthy();
    expect(projects.find((p) => p.id === empty.id)).toMatchObject({ pageCount: 0 });
    expect(projects.find((p) => p.id === empty.id)?.updatedAt).toBeUndefined();
  });

  it("names each project's last changed page, previewed on its card", async () => {
    const acme = await createProject("Acme");
    const landing = await createPage(acme.id, "Landing");
    const pricing = await createPage(acme.id, "Pricing");
    const empty = await createProject("Empty");
    expect((await home()).projects.find((p) => p.id === acme.id)?.lastPageId).toBe(pricing.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await server.post(`/api/pages/${landing.id}/versions`, { files: starterPageFiles("Landing again", null), message: "edit", origin: "terminal" });
    const { projects } = await home();
    expect(projects.find((p) => p.id === acme.id)?.lastPageId).toBe(landing.id);
    expect(projects.find((p) => p.id === empty.id)?.lastPageId).toBeUndefined();
  });

  it("gives each agent its covered projects: a project agent its own, the global agent those without one", async () => {
    const acme = await createProject("Acme");
    const blog = await createProject("Blog");
    const projectAgent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: acme.id });
    await projectAgent.hello;
    const global = await server.connectAgent({ machine: "iMac", folder: "/global", kind: "global" });
    await global.hello;
    const { agents } = await home();
    const byKind = Object.fromEntries(agents.map((a) => [a.kind, a.projects.map((p) => p.title)]));
    expect(byKind).toEqual({ project: ["Acme"], global: ["Blog"] });
    expect(agents.every((a) => a.status === "online" && a.running === 0)).toBe(true);
    expect(blog.id).toBeTruthy();
  });

  it("shows work running on an agent and threads waiting while the agent is offline", async () => {
    const acme = await createProject("Acme");
    const page = await createPage(acme.id, "Landing");
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: acme.id });
    await agent.hello;
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "h1", xPct: 1, yPct: 1, body: "Bigger" });
    await expect.poll(async () => (await home()).work.map((w) => w.state)).toEqual(["running"]);
    expect((await home()).agents[0]).toMatchObject({ running: 1, waitingThreads: 0 });

    await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "p", xPct: 2, yPct: 2, body: "Smaller" });
    await expect.poll(async () => (await home()).waitingThreads).toBe(1);
    expect((await home()).work.map((w) => [w.state, w.reason])).toEqual([
      ["running", undefined],
      ["waiting", "page-busy"],
    ]);
    expect((await home()).agents[0]).toMatchObject({ running: 1, waitingThreads: 1 });
  });
});
