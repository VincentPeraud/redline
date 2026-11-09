import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Page, PageVersionSummary, ShareLink, ShareLinkView, Thread } from "@redline/shared";
import { AccountsInstance, FILES } from "./accounts-harness.js";

const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const JSON_HEADERS = { "content-type": "application/json" };

describe("project links and Écriture links", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(() => instance.close());

  const setup = async () => {
    const project = await instance.createProject(instance.ariane);
    const pageId = await instance.createPage(instance.ariane, project.id);
    return { project, pageId };
  };
  const createLink = async (path: string, body: object = {}): Promise<ShareLink> => {
    const response = await instance.ariane.send("POST", path, { kind: "personal", name: "Alix", level: "read", ...body });
    expect(response.status).toBe(201);
    return (await response.json()) as ShareLink;
  };
  const visit = (link: ShareLink, path: string, method = "GET", body?: unknown) =>
    fetch(`${instance.server.url}/s/${link.token}${path}`, { method, headers: JSON_HEADERS, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });

  it("opens the pages of a project, those created after the link included and the archived ones left out", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(`/api/projects/${project.id}/links`);
    const view = (await (await visit(link, "/api/link")).json()) as ShareLinkView;
    expect(view).toMatchObject({ scope: "project", project: { id: project.id } });
    expect(view.page).toBeNull();

    const later = await instance.createPage(instance.ariane, project.id, "Later");
    const archived = await instance.createPage(instance.ariane, project.id, "Gone");
    await instance.ariane.send("POST", `/api/pages/${archived}/archive`);
    const listed = (await (await visit(link, `/api/projects/${project.id}/pages?archived=1`)).json()) as Page[];
    expect(listed.map((p) => p.id)).toEqual([pageId, later]);
    expect((await visit(link, `/api/pages/${later}`)).status).toBe(200);
    expect((await visit(link, `/api/pages/${archived}`)).status).toBe(403);
    expect((await visit(link, `/api/pages/${archived}/threads`)).status).toBe(403);
  });

  it("keeps a page link away from the list of the project's pages", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(`/api/pages/${pageId}/links`);
    expect((await visit(link, `/api/projects/${project.id}/pages`)).status).toBe(403);
  });

  it("lets an Écriture link work like a member: restore, team threads, Claude's agent, signed versions", async () => {
    const { project, pageId } = await setup();
    const agentToken = (await instance.ariane.json<{ token: string }>("/api/agent-token")).token;
    const agent = await instance.connectAgent(agentToken, { projectId: project.id });
    await agent.hello;
    const link = await createLink(`/api/pages/${pageId}/links`, { level: "write" });
    const first = (await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${pageId}/versions`))[0];
    await instance.ariane.send("POST", `/api/pages/${pageId}/versions`, { files: { ...FILES, "home.html": "<h1>Second</h1>" }, message: "Second", origin: "user" });
    await instance.ariane.send("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team thread", held: true });

    const versions = (await (await visit(link, `/api/pages/${pageId}/versions`)).json()) as PageVersionSummary[];
    expect(versions).toHaveLength(2);
    const restore = await visit(link, `/api/pages/${pageId}/versions/${first.id}/restore`, "POST", {});
    expect(restore.status).toBe(201);
    expect(((await restore.json()) as PageVersionSummary).linkAuthor).toEqual({ linkId: link.id, name: "Alix" });
    const asMember = await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${pageId}/versions`);
    expect(asMember[0].linkAuthor?.name).toBe("Alix");

    const seen = (await (await visit(link, `/api/pages/${pageId}/threads`)).json()) as Thread[];
    expect(seen.map((t) => t.body)).toEqual(["Team thread"]);

    const before = agent.messages.filter((m) => m.type === "work").length;
    const posted = await visit(link, `/api/pages/${pageId}/threads`, "POST", { target: { kind: "artboard", artboard: "home.html" }, body: "Bigger title" });
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as Thread).status).toBe("open");
    await tick();
    expect(agent.messages.filter((m) => m.type === "work").length).toBeGreaterThan(before);
    agent.close();
  });

  it("lets an Écriture project link create a page, and a Commentaire one not", async () => {
    const { project } = await setup();
    const write = await createLink(`/api/projects/${project.id}/links`, { level: "write" });
    const comment = await createLink(`/api/projects/${project.id}/links`, { level: "comment", name: "C" });
    const body = { title: "From Alix", files: FILES };
    expect((await visit(comment, `/api/projects/${project.id}/pages`, "POST", body)).status).toBe(403);
    const created = await visit(write, `/api/projects/${project.id}/pages`, "POST", body);
    expect(created.status).toBe(201);
    const page = (await created.json()) as Page;
    const versions = await instance.ariane.json<PageVersionSummary[]>(`/api/pages/${page.id}/versions`);
    expect(versions[0].linkAuthor?.name).toBe("Alix");
  });

  it("keeps links, archive, delete and agents out of reach of an Écriture link", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(`/api/pages/${pageId}/links`, { level: "write" });
    const projectLink = await createLink(`/api/projects/${project.id}/links`, { level: "write", name: "P" });
    for (const [method, path] of [
      ["GET", `/api/pages/${pageId}/links`],
      ["POST", `/api/pages/${pageId}/links`],
      ["GET", `/api/projects/${project.id}/links`],
      ["POST", `/api/projects/${project.id}/links`],
      ["POST", `/api/links/${link.id}/disable`],
      ["PATCH", `/api/links/${link.id}`],
      ["POST", `/api/pages/${pageId}/archive`],
      ["DELETE", `/api/pages/${pageId}`],
      ["POST", `/api/projects/${project.id}/archive`],
      ["DELETE", `/api/projects/${project.id}`],
      ["GET", "/api/agents"],
      ["GET", "/api/agent-token"],
    ] as const) {
      expect((await visit(link, path, method)).status, `${method} ${path} on a page link`).toBe(403);
      expect((await visit(projectLink, path, method)).status, `${method} ${path} on a project link`).toBe(403);
    }
  });

  it("shows members the name of the link behind a link comment", async () => {
    const { pageId } = await setup();
    const generic = await createLink(`/api/pages/${pageId}/links`, { kind: "generic", name: "Client HAIDF", level: "comment" });
    await visit(generic, `/api/pages/${pageId}/threads`, "POST", { target: { kind: "artboard", artboard: "home.html" }, body: "Hi", visitorName: "Marc" });
    const asMember = await instance.ariane.json<Thread[]>(`/api/pages/${pageId}/threads`);
    expect(asMember[0].linkAuthor).toEqual({ linkId: generic.id, name: "Marc", linkName: "Client HAIDF" });
    const asVisitor = (await (await visit(generic, `/api/pages/${pageId}/threads`)).json()) as Thread[];
    expect(asVisitor[0].linkAuthor).toEqual({ linkId: generic.id, name: "Marc" });
  });

  it("tells an Écriture visitor whether an agent serves the project, without naming it", async () => {
    const { project, pageId } = await setup();
    const link = await createLink(`/api/pages/${pageId}/links`, { level: "write" });
    const read = async () => (await (await visit(link, `/api/projects/${project.id}`)).json()) as Record<string, unknown>;
    expect(await read()).toEqual({ id: project.id, title: project.title, claudeAvailable: false });
    const agentToken = (await instance.ariane.json<{ token: string }>("/api/agent-token")).token;
    const agent = await instance.connectAgent(agentToken, { projectId: project.id });
    await agent.hello;
    expect(await read()).toEqual({ id: project.id, title: project.title, claudeAvailable: true });
    agent.close();
  });

  it("refuses an Écriture link for anyone", async () => {
    const { pageId } = await setup();
    const response = await instance.ariane.send("POST", `/api/pages/${pageId}/links`, { kind: "generic", name: "Anyone", level: "write" });
    expect(response.status).toBe(400);
  });
});
