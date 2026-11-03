import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const STYLED_MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}.modal{padding:8px}.modal-body{color:red}</style></head><body><template data-component><div class="modal"><h2><slot name="title"></slot></h2><slot></slot></div></template></body></html>`;
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

  describe("copied component markup", () => {
    const styledDesignSystem = async () =>
      (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"], [SIZE_TWEAK]), "components/modal.html": STYLED_MODAL } })).json()) as DesignSystem;

    it("refuses a project page using a component's classes, naming the tag and its settings", async () => {
      const ds = await styledDesignSystem();
      const response = await createPage(await project(), pageFiles(ds, `<div class="modal"><p>Copied</p></div>`));
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error).toContain("a.html");
      expect(error).toContain("<ui-modal>");
      expect(error).toContain("size");
    });

    it("refuses the same copy in a new version, and accepts the instance", async () => {
      const ds = await styledDesignSystem();
      const page = (await (await createPage(await project(), pageFiles(ds, `<ui-modal size="sm">x</ui-modal>`))).json()) as Page;
      expect((await publish(page.id, pageFiles(ds, `<section class="modal-body">x</section>`))).status).toBe(400);
      expect((await publish(page.id, pageFiles(ds, `<ui-modal>x</ui-modal>`))).status).toBe(201);
    });

    it("refuses classes of a project component as well", async () => {
      const ds = await styledDesignSystem();
      const card = `<!doctype html><html><head><style data-component>.card{padding:4px}</style></head><body><template data-component><div class="card"><slot></slot></div></template></body></html>`;
      const files = { ...pageFiles(ds, `<div class="card">x</div>`), "components/card.html": card, "manifest.json": manifestOf(["a.html", "components/card.html"], [], ds.id) };
      const response = await createPage(await project(), files);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("<ui-card>");
    });

    it("exempts a component's own file with a demo grid of self-instances", async () => {
      const ds = await styledDesignSystem();
      const banner = STYLED_MODAL.replace(/modal/g, "banner").replace("</body>", `<ui-banner size="sm">a</ui-banner><ui-banner size="md">b</ui-banner></body>`);
      const files = { ...pageFiles(ds, `<ui-modal>x</ui-modal>`), "components/banner.html": banner, "manifest.json": manifestOf(["a.html", "components/banner.html"], [{ ...SIZE_TWEAK, artboard: "components/banner.html" }], ds.id) };
      expect((await createPage(await project(), files)).status).toBe(201);
      const modal = STYLED_MODAL.replace("</body>", `<ui-modal size="sm">a</ui-modal><ui-modal size="md">b</ui-modal></body>`);
      const draft ={ "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"], [SIZE_TWEAK]), "components/modal.html": modal };
      expect((await publish(ds.pageId, draft)).status).toBe(201);
    });

    it("ignores content marked data-ds-libre", async () => {
      const ds = await styledDesignSystem();
      const response = await createPage(await project(), pageFiles(ds, `<div data-ds-libre><div class="modal">free</div></div><ui-modal>x</ui-modal>`));
      expect(response.status).toBe(201);
    });

    it("does not refuse classes of a component that has no instance template", async () => {
      const ds = (await (await server.post("/api/design-systems", { title: "Old DS", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/cta.html"]), "components/cta.html": `<!doctype html><html><head><style data-component>.cta{color:red}</style></head><body></body></html>` } })).json()) as DesignSystem;
      expect((await createPage(await project(), pageFiles(ds, `<a class="cta">Go</a>`))).status).toBe(201);
    });
  });
});
