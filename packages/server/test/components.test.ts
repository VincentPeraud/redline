import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[], designSystem?: string) => JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("components of design systems and projects", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const designSystemCss = async (id: string) => (await fetch(`${server.artboardOrigin}/design-systems/${id}/components.css`)).text();
  const projectCss = async (id: string) => (await fetch(`${server.artboardOrigin}/projects/${id}/components.css`)).text();
  const createDesignSystem = async (files: Record<string, string>) => (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, ...files } })).json()) as DesignSystem;
  const createProject = async () => ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
  const addPage = async (projectId: string, title: string, files: Record<string, string>) => server.post(`/api/projects/${projectId}/pages`, { title, files });
  const publish = (page: Page, files: Record<string, string>) => server.post(`/api/pages/${page.id}/versions`, { files, message: "Edit", origin: "thread" });

  it("serves a design system's assembled components.css, page then reading order, from every page", async () => {
    const ds = await createDesignSystem({
      "manifest.json": manifestOf(["components/button.html", "home.html"]),
      "components/button.html": component(".btn{a:1}"),
      "home.html": component(".home{b:2}"),
    });
    await addPage(ds.id, "Feedback", { "manifest.json": manifestOf(["components/badge.html"]), "components/badge.html": component(".badge{c:3}") });
    expect(await designSystemCss(ds.id)).toBe(".btn{a:1}\n.badge{c:3}\n");
  });

  it("serves an empty stylesheet for a design system with no component", async () => {
    const ds = await createDesignSystem({});
    const res = await fetch(`${server.artboardOrigin}/design-systems/${ds.id}/components.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(await res.text()).toBe("");
  });

  it("serves a project's assembled components.css from all its pages", async () => {
    const project = await createProject();
    await addPage(project, "Stories", { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".sticker{x:1}") });
    await addPage(project, "Reels", { "manifest.json": manifestOf(["components/frame.html"]), "components/frame.html": component(".frame{y:2}") });
    expect(await projectCss(project)).toBe(".sticker{x:1}\n.frame{y:2}\n");
  });

  it("serves the artboards of a project the design system's stylesheets, then the project's", async () => {
    const ds = await createDesignSystem({});
    const project = await createProject();
    const page = (await (await addPage(project, "Flow", { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": "<!doctype html><html><head></head><body></body></html>" })).json()) as Page;
    const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/a.html`)).text();
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    expect(hrefs).toEqual([`/design-systems/${ds.id}/diffusions/1/tokens.css`, `/design-systems/${ds.id}/diffusions/1/components.css`, `/project-styles/${project}/tokens.css`, `/projects/${project}/components.css`]);
  });

  it("does not link a design system's own components twice on its pages", async () => {
    const ds = await createDesignSystem({ "manifest.json": manifestOf(["a.html"], undefined), "a.html": "<!doctype html><html><head></head><body></body></html>" });
    const [first] = (await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[];
    const html = await (await fetch(`${server.artboardOrigin}/pages/${first.id}/a.html`)).text();
    expect(html).not.toContain(`/projects/${ds.id}/components.css`);
  });

  it("refuses a component name used twice in a project, naming both files", async () => {
    const project = await createProject();
    await addPage(project, "Stories", { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component("a{}") });
    const res = await addPage(project, "Reels", { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component("b{}") });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Component "sticker" is defined twice: components/sticker.html of page "Stories" and components/sticker.html of page "Reels"');
  });

  it("refuses a duplicate published as a new version of a page of a design system, and keeps the stored version", async () => {
    const ds = await createDesignSystem({ "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component("a{}") });
    const other = (await (await addPage(ds.id, "Forms", { "manifest.json": manifestOf(["components/input.html"]), "components/input.html": component("i{}") })).json()) as Page;
    const res = await publish(other, { "manifest.json": manifestOf(["components/input.html", "components/button.html"]), "components/input.html": component("i{}"), "components/button.html": component("b{}") });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("components/button.html");
    expect(await designSystemCss(ds.id)).toBe("a{}\ni{}\n");
  });

  it("accepts the same name in two different projects and republishing the same component", async () => {
    const one = await createProject();
    const two = await createProject();
    const files = { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component("a{}") };
    const page = (await (await addPage(one, "A", files)).json()) as Page;
    expect((await addPage(two, "B", files)).status).toBe(201);
    expect((await publish(page, { ...files, "components/sticker.html": component("c{}") })).status).toBe(201);
    expect(await projectCss(one)).toBe("c{}\n");
  });

  it("refuses restoring a version that brings back a component name another page now defines", async () => {
    const project = await createProject();
    const stories = (await (await addPage(project, "Stories", { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".s{x:1}") })).json()) as Page;
    const [first] = (await (await server.get(`/api/pages/${stories.id}/versions`)).json()) as { id: string }[];
    await publish(stories, { "manifest.json": manifestOf([]) });
    await addPage(project, "Reels", { "manifest.json": manifestOf(["components/sticker.html"]), "components/sticker.html": component(".s{y:2}") });

    const res = await server.post(`/api/pages/${stories.id}/versions/${first!.id}/restore`, {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("sticker");
    expect(((await (await server.get(`/api/pages/${stories.id}/versions`)).json()) as unknown[]).length).toBe(2);
  });
});
