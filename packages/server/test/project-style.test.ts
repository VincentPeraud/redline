import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, NEUTRAL_TOKENS_CSS, type AgentCheckout, type AgentTokenResponse, type DesignMdVersion, type DesignSystem, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { Store } from "../src/store.js";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const dsTokens = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111;`).join("\n")}\n}\n`;

describe("project style", () => {
  let server: TestServer;
  let token: string;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  });
  afterEach(async () => {
    await server.stop();
  });

  const createProject = async (designSystem?: string) => (await (await server.post("/api/projects", { title: "Acme", designSystem })).json()) as Project;
  const createDesignSystem = async () =>
    (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": dsTokens, "index.html": html } })).json()) as DesignSystem;
  const createPage = async (project: Project) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Flow", files: { "a.html": html } })).json()) as Page;
  const artboard = async (page: Page) => (await fetch(`${server.artboardOrigin}/pages/${page.id}/a.html`)).text();
  const styleUrl = (project: Project) => `/project-styles/${project.id}/tokens.css`;
  const styleCss = async (project: Project) => (await fetch(server.artboardOrigin + styleUrl(project))).text();
  const putStyle = (project: Project, content: string) =>
    fetch(`${server.url}/api/projects/${project.id}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  const versions = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/project-style/versions`)).json()) as DesignMdVersion[];
  const checkout = async (page: Page) => (await (await fetch(`${server.url}${AGENT_API_PREFIX}/pages/${page.id}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout;
  const publish = (page: Page, body: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}/pages/${page.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "m", origin: "thread", ...body }),
    });

  it("starts a project without a design system from the neutral values, linked after the design system", async () => {
    const project = await createProject();
    const page = await createPage(project);
    expect(await styleCss(project)).toBe(NEUTRAL_TOKENS_CSS);
    const markup = await artboard(page);
    const designSystemLink = markup.indexOf("/design-systems/");
    expect(designSystemLink).toBeGreaterThan(-1);
    expect(markup.indexOf(styleUrl(project))).toBeGreaterThan(designSystemLink);
  });

  it("gives a project with a shared design system an empty project style, so its values win when added", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    expect(await styleCss(project)).toBe("");
    await putStyle(project, ":root { --color-primary: #7c3aed; }\n");
    expect(await styleCss(project)).toContain("#7c3aed");
  });

  it("has no project style for a design system's own project", async () => {
    const ds = await createDesignSystem();
    const pages = (await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[];
    expect((await fetch(`${server.artboardOrigin}/project-styles/${ds.id}/tokens.css`)).status).toBe(404);
    expect(await artboard(pages[0]!)).not.toContain("/project-styles/");
  });

  it("versions each change with its origin, newest first, and skips an unchanged save", async () => {
    const project = await createProject();
    await putStyle(project, ":root { --color-primary: red; }\n");
    await putStyle(project, ":root { --color-primary: red; }\n");
    const list = await versions(project);
    expect(list.map((v) => v.origin)).toEqual(["user", "user"]);
    expect(list[0]!.content).toContain("red");
    expect(list[1]!.content).toBe(NEUTRAL_TOKENS_CSS);
  });

  it("puts the project style in the working copy, and the draft tokens for a design system page", async () => {
    const project = await createProject();
    const page = await createPage(project);
    expect((await checkout(page)).project.projectStyle).toBe(NEUTRAL_TOKENS_CSS);
    const ds = await createDesignSystem();
    const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
    const dsCheckout = await checkout(dsPage);
    expect(dsCheckout.project.projectStyle).toContain("--color-primary");
    expect(dsCheckout.project.designSystem).toBeUndefined();
    expect(dsCheckout.project.editsDesignSystem?.id).toBe(ds.id);
  });

  it("saves a project style published with a page as a version carrying its origin, and refuses a stale base", async () => {
    const project = await createProject();
    const page = await createPage(project);
    const { versionId } = await checkout(page);
    const edited = ":root { --color-primary: #7c3aed; }\n";
    const res = await publish(page, { files: { "a.html": html }, baseVersionId: versionId, projectStyle: { content: edited, base: NEUTRAL_TOKENS_CSS }, origin: "terminal" });
    expect(res.status).toBe(201);
    expect(await styleCss(project)).toBe(edited);
    expect((await versions(project))[0]).toMatchObject({ origin: "terminal" });

    const stale = await publish(page, { files: { "a.html": html }, baseVersionId: (await checkout(page)).versionId, projectStyle: { content: "x{}", base: NEUTRAL_TOKENS_CSS } });
    expect(stale.status).toBe(409);
    expect(await styleCss(project)).toBe(edited);
  });

  it("requires content and base for a published project style", async () => {
    const project = await createProject();
    const page = await createPage(project);
    const res = await publish(page, { files: { "a.html": html }, baseVersionId: (await checkout(page)).versionId, projectStyle: { content: "x" } });
    expect(res.status).toBe(400);
  });
});

describe("migration of existing projects", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-style-migration-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("gives a project stored without a project style the neutral values, once", () => {
    const seed = new Store(dataDir);
    const project = seed.createProject("Old");
    seed.close();
    const db = new Database(join(dataDir, "redline.db"));
    db.prepare("DELETE FROM project_files WHERE project_id = ? AND path = 'tokens.css'").run(project.id);
    db.prepare("DELETE FROM design_md_versions WHERE project_id = ? AND path = 'tokens.css'").run(project.id);
    db.close();

    const store = new Store(dataDir);
    expect(store.readProjectFile(project.id, "tokens.css")?.toString("utf8")).toBe(NEUTRAL_TOKENS_CSS);
    expect(store.listDesignMdVersions(project.id, "tokens.css")).toHaveLength(1);
    store.close();
    const again = new Store(dataDir);
    expect(again.listDesignMdVersions(project.id, "tokens.css")).toHaveLength(1);
    again.close();
  });

  it("leaves a project with a design system without a project style", () => {
    const store = new Store(dataDir);
    const ds = store.createDesignSystem("DS", { "tokens.css": dsTokens, "index.html": html });
    const project = store.createProject("With DS", undefined, "", ds.id);
    store.close();
    const again = new Store(dataDir);
    expect(again.readProjectFile(project.id, "tokens.css")).toBeUndefined();
    expect(again.listDesignMdVersions(ds.id, "tokens.css")).toHaveLength(1);
    again.close();
  });
});
