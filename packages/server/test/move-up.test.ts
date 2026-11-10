import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DiffusionReview, type Page, type Project, type ProjectDesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? "#111111" : "#000000"};`).join("\n")}\n}\n`;

const componentFile = (template: string, css = "") =>
  `<!doctype html><html><head><style data-component>${css}</style></head><body><template data-component>${template}</template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

const CARD = componentFile(`<article class="mission-card"><slot></slot></article>`, ".mission-card{padding:8px}");
const SHARED_CARD = componentFile(`<section class="ds-card"><slot></slot></section>`, ".ds-card{padding:4px}");

describe("moving a project component up to the design system", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const createDesignSystem = async () =>
    (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": componentFile(`<div class="modal"><slot></slot></div>`) },
    })).json()) as DesignSystem & { pageId: string };
  const createProject = async (designSystem: string) => (await (await server.post("/api/projects", { title: "App", designSystem })).json()) as Project;
  const pageOf = async (project: Project, title: string, files: Record<string, string>) => (await (await server.post(`/api/projects/${project.id}/pages`, { title, files })).json()) as Page;
  const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;
  const review = async (ds: DesignSystem) => (await (await server.get(`/api/design-systems/${ds.id}/review`)).json()) as DiffusionReview;
  const moveUp = (project: Project, name: string, pageId: string) => server.post(`/api/projects/${project.id}/design-system/components/${name}/move-up`, { pageId });
  const diffuse = (ds: DesignSystem) => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const pageFile = async (page: { id: string }, path: string) => {
    const response = await server.get(`/api/pages/${page.id}/files/${path}`);
    return response.status === 404 ? undefined : response.text();
  };

  const missionsPage = (project: Project, ds: DesignSystem) =>
    pageOf(project, "Missions", {
      "manifest.json": manifestOf(["a.html", "components/mission-card.html"], ds.id),
      "a.html": mockup(`<ui-mission-card>1</ui-mission-card><ui-mission-card>2</ui-mission-card>`),
      "components/mission-card.html": CARD,
    });

  it("copies the component into the chosen design system page and keeps the project's own until diffusion", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await missionsPage(project, ds);

    const response = await moveUp(project, "mission-card", ds.pageId);
    expect(response.status).toBe(200);

    expect(await pageFile({ id: ds.pageId }, "components/mission-card.html")).toBe(CARD);
    expect(JSON.parse((await pageFile({ id: ds.pageId }, "manifest.json"))!).artboards.map((a: { file: string }) => a.file)).toEqual(["components/modal.html", "components/mission-card.html"]);

    expect(await pageFile(page, "components/mission-card.html")).toBe(CARD);
    const { components } = await detail(project);
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ name: "mission-card", movedUp: true, inDesignSystem: false });
  });

  it("refuses a name the design system already has, an unknown page and an unknown component", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    await missionsPage(project, ds);
    expect((await moveUp(project, "mission-card", "nope")).status).toBe(400);
    expect((await moveUp(project, "ghost", ds.pageId)).status).toBe(404);

    await moveUp(project, "mission-card", ds.pageId);
    expect((await moveUp(project, "mission-card", ds.pageId)).status).toBe(409);
  });

  it("tells the review where the instances come from, and not that the project keeps its own", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    await missionsPage(project, ds);
    await moveUp(project, "mission-card", ds.pageId);

    const card = (await review(ds)).components.find((c) => c.name === "mission-card")!;
    expect(card.where.movedUp).toEqual([{ project: "App", instances: 2 }]);
    expect(card.where.keptBy).toEqual([]);
    expect(card.changes.map((c) => c.label)).toEqual(["Composant remonté depuis App"]);
  });

  it("deletes the project's copy at the diffusion that contains the component, so the same tags show the design system's", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await missionsPage(project, ds);
    await moveUp(project, "mission-card", ds.pageId);

    expect((await diffuse(ds)).status).toBe(201);

    expect(await pageFile(page, "components/mission-card.html")).toBeUndefined();
    expect(await pageFile(page, "a.html")).toContain("<ui-mission-card>1</ui-mission-card>");
    const after = await detail(project);
    expect(after.components).toEqual([]);
  });

  it("keeps the project's component while the design system has not diffused the moved one", async () => {
    const ds = await createDesignSystem();
    const project = await createProject(ds.id);
    const page = await missionsPage(project, ds);
    await moveUp(project, "mission-card", ds.pageId);
    // The draft loses the copy again before any diffusion: the project's one must not disappear.
    const edit = await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "x.html"]), "components/modal.html": componentFile(`<div class="modal"><slot></slot></div>`), "x.html": mockup("<p>x</p>") }, message: "Edit", origin: "thread", confirmRemovals: true });
    expect(edit.status).toBe(201);
    await diffuse(ds);
    expect(await pageFile(page, "components/mission-card.html")).toBe(CARD);
  });

  describe("a homonym diffused by the design system", () => {
    const diffuseHomonym = async (ds: DesignSystem & { pageId: string }) => {
      await server.post(`/api/pages/${ds.pageId}/versions`, {
        files: {
          "tokens.css": tokensCss,
          "manifest.json": manifestOf(["components/modal.html", "components/mission-card.html"]),
          "components/modal.html": componentFile(`<div class="modal"><slot></slot></div>`),
          "components/mission-card.html": SHARED_CARD,
        },
        message: "Edit",
        origin: "thread",
      });
      await diffuse(ds);
    };

    it("leaves the project's one in use, flagged with the diffusion that brought the name", async () => {
      const ds = await createDesignSystem();
      const project = await createProject(ds.id);
      const page = await missionsPage(project, ds);
      await diffuseHomonym(ds);

      expect(await pageFile(page, "components/mission-card.html")).toBe(CARD);
      const { components } = await detail(project);
      expect(components[0]).toMatchObject({ name: "mission-card", inDesignSystem: true, movedUp: false, diffusedSince: 2 });
    });

    it("\"Passer à celui du design system\" deletes the project's component", async () => {
      const ds = await createDesignSystem();
      const project = await createProject(ds.id);
      const page = await missionsPage(project, ds);
      await diffuseHomonym(ds);

      const response = await server.post(`/api/projects/${project.id}/design-system/components/mission-card/use-design-system`, {});
      expect(response.status).toBe(200);
      expect(((await response.json()) as ProjectDesignSystem).components).toEqual([]);
      expect(await pageFile(page, "components/mission-card.html")).toBeUndefined();
    });

    it("refuses to switch a component the design system does not have", async () => {
      const ds = await createDesignSystem();
      const project = await createProject(ds.id);
      await missionsPage(project, ds);
      expect((await server.post(`/api/projects/${project.id}/design-system/components/mission-card/use-design-system`, {})).status).toBe(409);
    });
  });
});
