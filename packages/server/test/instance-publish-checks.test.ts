import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const MODAL = componentFile(`<div><h2><slot name="title"></slot></h2><slot></slot></div>`);
const SIZE_TWEAK = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };

const manifestOf = (files: string[], tweaks: object[] = [], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("publish checks on instances", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const designSystem = async () =>
    (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"], [SIZE_TWEAK]), "components/modal.html": MODAL } })).json()) as DesignSystem;
  const project = async () => ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
  const pageFiles = (ds: DesignSystem, body: string) => ({ "manifest.json": manifestOf(["a.html"], [], ds.id), "a.html": mockup(body) });
  const publish = (pageId: string, files: Record<string, string>) => server.post(`/api/pages/${pageId}/versions`, { files, message: "Edit", origin: "thread" });
  const createPage = async (projectId: string, files: Record<string, string>) => server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files });

  it("refuses an unknown ui- tag and lists the available tags", async () => {
    const ds = await designSystem();
    const response = await createPage(await project(), pageFiles(ds, `<ui-unknown>x</ui-unknown>`));
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("<ui-unknown>");
    expect(error).toContain("a.html");
    expect(error).toContain("ui-modal");
  });

  it("refuses a setting value the component lacks and lists the values", async () => {
    const ds = await designSystem();
    const response = await createPage(await project(), pageFiles(ds, `<ui-modal size="xl">x</ui-modal>`));
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(`size="xl"`);
    expect(error).toContain("sm, md");
  });

  it("refuses a slot the component lacks and lists the slots", async () => {
    const ds = await designSystem();
    const response = await createPage(await project(), pageFiles(ds, `<ui-modal><div slot="footer">ok</div></ui-modal>`));
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain(`slot="footer"`);
    expect(error).toContain("title");
  });

  it("publishes a valid page as before, and refuses the same mistakes in a new version", async () => {
    const ds = await designSystem();
    const projectId = await project();
    const created = await createPage(projectId, pageFiles(ds, `<ui-modal size="sm"><span slot="title">T</span><p>x</p></ui-modal>`));
    expect(created.status).toBe(201);
    const page = (await created.json()) as Page;
    expect((await publish(page.id, pageFiles(ds, `<ui-modal size="md">y</ui-modal>`))).status).toBe(201);
    expect((await publish(page.id, pageFiles(ds, `<ui-modal size="xl">y</ui-modal>`))).status).toBe(400);
  });

  it("checks a design system page against its draft, and a project page against its own components", async () => {
    const ds = await designSystem();
    const draftFiles = { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "p.html"], [SIZE_TWEAK]), "components/modal.html": MODAL };
    expect((await publish(ds.pageId, { ...draftFiles, "p.html": mockup(`<ui-modal size="sm">x</ui-modal>`) })).status).toBe(201);
    expect((await publish(ds.pageId, { ...draftFiles, "p.html": mockup(`<ui-nope></ui-nope>`) })).status).toBe(400);

    const card = componentFile(`<div><slot></slot></div>`);
    const files = { ...pageFiles(ds, `<ui-card>x</ui-card>`), "components/card.html": card, "manifest.json": manifestOf(["a.html", "components/card.html"], [], ds.id) };
    expect((await createPage(await project(), files)).status).toBe(201);
  });
});
