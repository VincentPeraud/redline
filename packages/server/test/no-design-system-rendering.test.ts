import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_API_PREFIX,
  CORE_TOKENS,
  NEUTRAL_DESIGN_SYSTEM_ID,
  NEUTRAL_TOKENS_CSS,
  versionPreviewPath,
  type AgentDesignSystem,
  type AgentTokenResponse,
  type ArtboardVersion,
  type DesignSystem,
  type Page,
  type Project,
  type ServerEvent,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { Store } from "../src/store.js";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
const dsTokens = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111;`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("a project without a design system renders with its project style only", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
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

  it("links the project style and the project components, and no design system stylesheet", async () => {
    const project = await createProject();
    const markup = await artboard(await createPage(project));
    expect(markup).toContain(`/project-styles/${project.id}/tokens.css`);
    expect(markup).toContain(`/projects/${project.id}/components.css`);
    expect(markup).not.toContain("/design-systems/");
  });

  it("still links the design system stylesheets of a project with a shared design system", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const manifest = JSON.stringify({ designSystem: ds.id, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }] });
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Flow", files: { "a.html": html, "manifest.json": manifest } })).json()) as Page;
    const markup = await artboard(page);
    expect(markup).toContain(`/design-systems/${ds.id}/diffusions/1/tokens.css`);
    expect(markup).toContain(`/design-systems/${ds.id}/diffusions/1/components.css`);
  });

  it("records no diffusion for a version published without a design system, and previews it with the project style", async () => {
    const project = await createProject();
    const page = await createPage(project);
    const res = await server.post(`/api/pages/${page.id}/versions`, { files: { "a.html": html.replace("Hi", "Second") }, message: "second", origin: "thread" });
    expect(res.status).toBe(201);
    const history = (await (await server.get(`/api/pages/${page.id}/artboard-versions?file=a.html`)).json()) as ArtboardVersion[];
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((v) => v.diffusion === undefined)).toBe(true);
    const preview = await (await fetch(`${server.artboardOrigin}${versionPreviewPath(page.id, history[0]!.versionId, "a.html")}`)).text();
    expect(preview).toContain(`/project-styles/${project.id}/tokens.css`);
    expect(preview).not.toContain("/design-systems/");
  });

  it("does not reference the neutral design system in the reload events of a components change", async () => {
    const project = await createProject();
    const first = await createPage(project);
    const controller = new AbortController();
    let text = "";
    const stream = await fetch(`${server.url}/api/events`, { signal: controller.signal });
    void (async () => {
      const reader = stream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // aborted
      }
    })();
    await server.post(`/api/pages/${first.id}/versions`, {
      files: { "a.html": html, "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".s{color:red}") },
      message: "m",
      origin: "thread",
    });
    const updates = () =>
      text
        .split("\n\n")
        .flatMap((f) => (f.startsWith("data: ") ? [JSON.parse(f.slice(6)) as ServerEvent] : []))
        .filter((e) => e.type === "design-system-updated");
    for (let i = 0; i < 100 && updates().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(updates().length).toBeGreaterThan(0);
    for (const event of updates()) expect(event).not.toHaveProperty("designSystemId", NEUTRAL_DESIGN_SYSTEM_ID);
  });

  it("hides the Neutral design system from every list", async () => {
    const ds = await createDesignSystem();
    const web = (await (await server.get("/api/design-systems")).json()) as DesignSystem[];
    expect(web.map((d) => d.id)).toEqual([ds.id]);
    const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
    const agent = (await (await fetch(`${server.url}${AGENT_API_PREFIX}/design-systems`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentDesignSystem[];
    expect(agent.map((d) => d.id)).toEqual([ds.id]);
  });

  it("gives a new project without a design system an empty project style", async () => {
    const project = await createProject();
    const res = await fetch(`${server.artboardOrigin}/project-styles/${project.id}/tokens.css`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("start-up migration of project styles", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-no-ds-migration-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("keeps the Neutral design system record", () => {
    const store = new Store(dataDir);
    expect(store.getDesignSystem(NEUTRAL_DESIGN_SYSTEM_ID)).toBeDefined();
    store.close();
  });

  it("gives a project without a project style file the neutral values, and leaves a new project's empty style empty after a restart", () => {
    const seed = new Store(dataDir);
    const old = seed.createProject("Old");
    const fresh = seed.createProject("Fresh");
    seed.close();
    const db = new Database(join(dataDir, "redline.db"));
    db.prepare("DELETE FROM project_files WHERE project_id = ? AND path = 'tokens.css'").run(old.id);
    db.prepare("DELETE FROM design_md_versions WHERE project_id = ? AND path = 'tokens.css'").run(old.id);
    db.close();

    const store = new Store(dataDir);
    expect(store.readProjectFile(old.id, "tokens.css")?.toString("utf8")).toBe(NEUTRAL_TOKENS_CSS);
    expect(store.readProjectFile(fresh.id, "tokens.css")?.toString("utf8")).toBe("");
    store.close();
  });
});
