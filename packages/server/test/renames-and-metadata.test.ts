import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ELEMENT_NAME_LENGTH, MAX_TITLE_LENGTH, type Conversation, type DesignMdInfo, type Page, type Project, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { startServer } from "../src/start.js";

describe("renames, page creator, element name, conversation counts, DESIGN.md origins over the HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const patch = (path: string, body: unknown) =>
    fetch(server.url + path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function setup() {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "home.html": "<h1>x</h1>" } })).json()) as Page;
    return { project, page };
  }

  it("renames a project and a page, trimmed, refusing empty or too long names", async () => {
    const { project, page } = await setup();

    const renamedProject = (await (await patch(`/api/projects/${project.id}`, { title: "  Acme Inc  " })).json()) as Project;
    expect(renamedProject.title).toBe("Acme Inc");
    expect(((await (await server.get(`/api/projects/${project.id}`)).json()) as Project).title).toBe("Acme Inc");
    const renamedPage = (await (await patch(`/api/pages/${page.id}`, { title: "Pricing" })).json()) as Page;
    expect(renamedPage).toMatchObject({ id: page.id, title: "Pricing" });

    for (const title of ["", "   ", 3, "x".repeat(MAX_TITLE_LENGTH + 1)]) {
      expect((await patch(`/api/projects/${project.id}`, { title })).status).toBe(400);
      expect((await patch(`/api/pages/${page.id}`, { title })).status).toBe(400);
    }
    expect((await patch(`/api/projects/nope`, { title: "X" })).status).toBe(404);
    expect((await patch(`/api/pages/nope`, { title: "X" })).status).toBe(404);
    expect((await patch(`/api/pages/${page.id}`, { title: "x".repeat(MAX_TITLE_LENGTH) })).status).toBe(200);
  });

  it("marks pages created through the API as created by the user", async () => {
    const { page } = await setup();
    expect(page.createdBy).toBe("user");
    expect(page).not.toHaveProperty("type");
  });

  it("ignores a page type sent by an old client", async () => {
    const { project } = await setup();
    const res = await server.post(`/api/projects/${project.id}/pages`, { title: "Old client", type: "comparison", files: { "a.html": "<p/>" } });
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("type");
  });

  it("stores the element name with a thread (null on threads without one) and bounds its length", async () => {
    const { page } = await setup();
    const pin = { artboard: "home.html", selector: "h1", xPct: 1, yPct: 2, body: "Hi", held: true };
    const named = (await (await server.post(`/api/pages/${page.id}/threads`, { ...pin, elementName: "titre « Bienvenue »" })).json()) as Thread;
    const plain = (await (await server.post(`/api/pages/${page.id}/threads`, pin)).json()) as Thread;

    const listed = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
    expect(listed.map((t) => t.elementName)).toEqual(["titre « Bienvenue »", null]);
    expect([named.elementName, plain.elementName]).toEqual(["titre « Bienvenue »", null]);
    expect((await server.post(`/api/pages/${page.id}/threads`, { ...pin, elementName: 3 })).status).toBe(400);
    expect((await server.post(`/api/pages/${page.id}/threads`, { ...pin, elementName: "x".repeat(MAX_ELEMENT_NAME_LENGTH + 1) })).status).toBe(400);
  });

  it("counts exchanges (one user message each) and gives the last activity of every conversation", async () => {
    const { page } = await setup();
    const conversation = (await (await server.post(`/api/pages/${page.id}/conversations`, { title: "Tone" })).json()) as Conversation;
    expect(conversation).toMatchObject({ exchangeCount: 0, lastActivityAt: conversation.createdAt });

    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "First" });
    await server.post(`/api/conversations/${conversation.id}/messages`, { body: "Second" });
    const [listed] = (await (await server.get(`/api/pages/${page.id}/conversations`)).json()) as Conversation[];
    expect(listed.exchangeCount).toBe(2);
    expect(new Date(listed.lastActivityAt).getTime()).toBeGreaterThanOrEqual(new Date(conversation.createdAt).getTime());
    const detail = (await (await server.get(`/api/conversations/${conversation.id}`)).json()) as Conversation;
    expect(detail.exchangeCount).toBe(2);
  });

  it("refuses an agent publish whose DESIGN.md changed meanwhile, and publishes nothing", async () => {
    const { project, page } = await setup();
    await put(`/api/projects/${project.id}/design-md`, { content: "- mine\n" });
    const { token } = (await (await server.get("/api/agent-token")).json()) as { token: string };
    const publish = (base: string) =>
      fetch(`${server.url}/agent-api/pages/${page.id}/versions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ files: { "home.html": "<h1>y</h1>" }, message: "m", origin: "thread", baseVersionId: page.version.id, designMd: { content: "- theirs\n", base } }),
      });

    expect((await publish("- an older text\n")).status).toBe(409);
    expect(((await (await server.get(`/api/pages/${page.id}/versions`)).json()) as unknown[]).length).toBe(1);
    expect((await publish("- mine\n")).status).toBe(201);
    expect(((await (await server.get(`/api/projects/${project.id}/design-md`)).json()) as { content: string }).content).toBe("- theirs\n");
  });

  it("reports DESIGN.md's last modification, version count and the origin of each line", async () => {
    const { project } = await setup();
    const info = () => server.get(`/api/projects/${project.id}/design-md/info`).then((r) => r.json() as Promise<DesignMdInfo>);
    expect(await info()).toEqual({ versionCount: 0, lastModified: null, rules: [] });

    await put(`/api/projects/${project.id}/design-md`, { content: "# Design\n\n- Round buttons\n- Dark footer\n- Round buttons\n" });
    await put(`/api/projects/${project.id}/design-md`, { content: "# Design\n\n- Round buttons\n- Dark footer\n- Round buttons\n- Sentence case\n" });
    // Edited line = new rule; a third "Round buttons" is a new occurrence of an existing text.
    await put(`/api/projects/${project.id}/design-md`, { content: "# Design\n\n- Round buttons\n- Very dark footer\n- Round buttons\n- Sentence case\n- Round buttons\n" });

    const result = await info();
    expect(result.versionCount).toBe(3);
    expect(result.lastModified).toMatchObject({ origin: "user" });
    const versions = (await (await server.get(`/api/projects/${project.id}/design-md/versions`)).json()) as { id: string }[];
    const [third, second, first] = versions.map((v) => v.id);
    expect(result.rules.map((r) => [r.line, r.text, r.versionId])).toEqual([
      [1, "# Design", first],
      [3, "- Round buttons", first],
      [4, "- Very dark footer", third],
      [5, "- Round buttons", first],
      [6, "- Sentence case", second],
      [7, "- Round buttons", third],
    ]);
    expect((await server.get("/api/projects/nope/design-md/info")).status).toBe(404);
  });
});

describe("opening a database from before page types were removed", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "redline-old-db-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps projects and pages, drops the page type, and turns an allowed takeover into an override", async () => {
    const old = new Database(join(dir, "redline.db"));
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', design_system TEXT, created_at TEXT NOT NULL, allow_global_takeover INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE versions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, files TEXT NOT NULL, created_at TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'terminal');
      INSERT INTO projects (id, title, created_at, allow_global_takeover) VALUES ('p-allow', 'Allow', '2026-01-01', 1), ('p-default', 'Default', '2026-01-02', 0);
      INSERT INTO pages (id, project_id, title, type, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 'p-allow', 'Old page', 'comparison', '2026-01-01');
      INSERT INTO versions (id, page_id, files, created_at, message, origin) VALUES ('v1', '11111111-1111-4111-8111-111111111111', '{}', '2026-01-01', 'Page created', 'creation');
    `);
    old.close();

    const running = await startServer({ dataDir: dir, port: 0, artboardPort: 0, host: "127.0.0.1" });
    try {
      const projects = (await (await fetch(`${running.url}/api/projects`)).json()) as Project[];
      expect(projects.map((p) => [p.id, p.globalTakeoverOverride, p.globalTakeover])).toEqual([
        ["p-allow", true, true],
        ["p-default", null, false],
      ]);
      const page = (await (await fetch(`${running.url}/api/pages/11111111-1111-4111-8111-111111111111`)).json()) as Page;
      expect(page).toMatchObject({ title: "Old page", createdBy: "user" });
      expect(page).not.toHaveProperty("type");
      const created = await fetch(`${running.url}/api/projects/p-default/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New", files: { "a.html": "<p/>" } }),
      });
      expect(created.status).toBe(201);
    } finally {
      await running.close();
    }
  });
});
