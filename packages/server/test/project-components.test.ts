import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem, type Page, type PageGaps, type Project, type ProjectDesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? "#111111" : "#000000"};`).join("\n")}\n}\n`;

const componentFile = (template: string, css = "") =>
  `<!doctype html><html><head><style data-component>${css}</style></head><body><template data-component>${template}</template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

const CARD = componentFile(`<article class="mission-card"><slot></slot></article>`, ".mission-card{padding:8px}");

describe("project components", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  const createDesignSystem = async () =>
    (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": componentFile(`<div class="modal"><slot></slot></div>`) },
    })).json()) as DesignSystem;
  const createProject = async (designSystem: string) => (await (await server.post("/api/projects", { title: "App", designSystem })).json()) as Project;
  const createPage = (project: Project, title: string, files: Record<string, string>) => server.post(`/api/projects/${project.id}/pages`, { title, files });
  const pageOf = async (project: Project, title: string, files: Record<string, string>) => (await (await createPage(project, title, files)).json()) as Page;
  const publish = (pageId: string, files: Record<string, string>) => server.post(`/api/pages/${pageId}/versions`, { files, message: "Edit", origin: "thread" });
  const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;
  const gapsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/gaps`)).json()) as PageGaps;

  const cardPageFiles = (ds: DesignSystem, body: string, card = CARD) => ({
    "manifest.json": manifestOf(["a.html", "components/mission-card.html"], ds.id),
    "a.html": mockup(body),
    "components/mission-card.html": card,
  });

  it("renders a project component through its ui- tag in the project's pages", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await pageOf(project, "Missions", cardPageFiles(ds, `<ui-mission-card><p>Hello</p></ui-mission-card>`));
    const other = await pageOf(project, "Other", { "manifest.json": manifestOf(["b.html"], ds.id), "b.html": mockup(`<ui-mission-card><p>Again</p></ui-mission-card>`) });
    for (const [p, file] of [[page, "a.html"], [other, "b.html"]] as const) {
      const dom = await JSDOM.fromURL(`${server.artboardOrigin}/pages/${p.id}/${file}`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
      windows.push(dom.window);
      await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
      expect(dom.window.document.querySelector("ui-mission-card article.mission-card p")).not.toBeNull();
    }
  });

  it("refuses to publish a project component named like a design system component", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const response = await createPage(project, "Missions", { "manifest.json": manifestOf(["components/modal.html"], ds.id), "components/modal.html": CARD });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("ui-modal");
    expect(error).toContain("design system");

    const page = await pageOf(project, "Missions", cardPageFiles(ds, `<ui-mission-card></ui-mission-card>`));
    const renamed = await publish(page.id, {
      ...cardPageFiles(ds, `<p>x</p>`),
      "components/modal.html": CARD,
      "manifest.json": manifestOf(["a.html", "components/mission-card.html", "components/modal.html"], ds.id),
    });
    expect(renamed.status).toBe(400);
  });

  it("lets a project keep a component whose name the design system diffuses later, until it is touched", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await pageOf(project, "Missions", cardPageFiles(ds, `<ui-mission-card>x</ui-mission-card>`));
    await publish(ds.pageId, {
      "tokens.css": tokensCss,
      "manifest.json": manifestOf(["components/modal.html", "components/mission-card.html"]),
      "components/modal.html": componentFile(`<div><slot></slot></div>`),
      "components/mission-card.html": componentFile(`<section><slot></slot></section>`),
    });
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});

    expect((await publish(page.id, cardPageFiles(ds, `<ui-mission-card>y</ui-mission-card>`))).status).toBe(201);
    const touched = await publish(page.id, cardPageFiles(ds, `<ui-mission-card>y</ui-mission-card>`, componentFile(`<article class="mission-card changed"><slot></slot></article>`)));
    expect(touched.status).toBe(400);
  });

  it("lists project components as propre au projet, with their instance and page counts, and no override status", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    await pageOf(project, "Missions", cardPageFiles(ds, `<ui-mission-card>1</ui-mission-card><ui-mission-card>2</ui-mission-card><ui-modal>m</ui-modal>`));
    await pageOf(project, "Other", { "manifest.json": manifestOf(["b.html"], ds.id), "b.html": mockup(`<ui-mission-card>3</ui-mission-card>`) });
    await pageOf(project, "Unused", { "manifest.json": manifestOf(["c.html"], ds.id), "c.html": mockup(`<p>none</p>`) });
    const { components } = await detail(project);
    expect(components).toEqual([{ name: "mission-card", file: "components/mission-card.html", page: { id: expect.any(String), title: "Missions" }, instances: 3, pages: 2, inDesignSystem: false, movedUp: false }]);
  });

  it("measures a project component's gaps like a page, and respects data-ds-libre", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const dirty = componentFile(`<article class="mission-card"><slot></slot></article>`, ".mission-card{color:#ff0000}");
    const page = await pageOf(project, "Missions", cardPageFiles(ds, `<p>x</p>`, dirty));
    expect((await gapsOf(page)).gaps.map((g) => [g.file, g.kind, g.value])).toEqual([["components/mission-card.html", "color", "#ff0000"]]);

    const freed = componentFile(`<article class="mission-card" data-ds-libre style="color:#ff0000"><slot></slot></article>`);
    const clean = await pageOf(project, "Clean", { "manifest.json": manifestOf(["components/other.html"], ds.id), "components/other.html": freed });
    expect((await gapsOf(clean)).gaps).toEqual([]);
  });
});
