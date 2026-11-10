import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest, type FitArtboardHeightRequest, type Page, type PageVersionSummary, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const html = "<!doctype html><h1>Hi</h1>";

describe("artboard height that follows its page", () => {
  let server: TestServer;
  let project: Project;

  beforeEach(async () => {
    server = await startTestServer();
    project = (await (await server.post("/api/projects", { title: "Escale" })).json()) as Project;
  });
  afterEach(async () => {
    await server.stop();
  });

  const createPage = async (artboards: unknown[]) =>
    server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "landing.html": html, "article.html": html, [MANIFEST_PATH]: JSON.stringify({ artboards }) } });
  const manifestOf = async (page: Page) => parseManifest(await (await server.get(`/api/pages/${page.id}/files/${MANIFEST_PATH}`)).text());
  const fit = (page: Page, request: Partial<FitArtboardHeightRequest>) => server.post(`/api/pages/${page.id}/fit-height`, request);

  it('accepts "height": "fit" on a plain artboard, which starts at the default height', async () => {
    const res = await createPage([{ file: "article.html", x: 0, y: 0, width: 1440, height: "fit" }]);
    expect(res.status).toBe(201);
    const [artboard] = (await manifestOf((await res.json()) as Page)).artboards;
    expect(artboard).toMatchObject({ file: "article.html", width: 1440, fitHeight: true });
    expect(typeof artboard!.height).toBe("number");
  });

  it('refuses "height": "fit" on a responsive artboard or a tweak grid, and any other text', async () => {
    const responsive = await createPage([{ file: "article.html", height: "fit", responsive: ["desktop"] }]);
    expect(responsive.status).toBe(400);
    expect(((await responsive.json()) as { error: string }).error).toMatch(/artboards\[0\]\.height "fit"/);
    const text = await createPage([{ file: "article.html", height: "auto" }]);
    expect(((await text.json()) as { error: string }).error).toMatch(/artboards\[0\]\.height must be a positive number or "fit"/);
  });

  it("saves the measured height of a fixed artboard in its manifest entry, as a new version", async () => {
    const page = (await (await createPage([{ file: "landing.html", x: 40, y: 0, width: 1440, height: 900 }, { file: "article.html", x: 1520, y: 0 }])).json()) as Page;
    const res = await fit(page, { file: "landing.html", height: 3200.4 });
    expect(res.status).toBe(201);
    expect((await res.json()) as PageVersionSummary).toMatchObject({ message: "Hauteur de landing.html ajustée au contenu (3201 px)", origin: "user" });
    const manifest = await manifestOf(page);
    expect(manifest.artboards[0]).toMatchObject({ file: "landing.html", x: 40, width: 1440, height: 3201 });
    expect(manifest.artboards[1]).toMatchObject({ file: "article.html", x: 1520 });
  });

  it("writes a manifest for a page that had none", async () => {
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Sans manifest", files: { "landing.html": html } })).json()) as Page;
    expect((await fit(page, { file: "landing.html", height: 2000 })).status).toBe(201);
    expect((await manifestOf(page)).artboards[0]).toMatchObject({ file: "landing.html", height: 2000 });
  });

  it("refuses an unknown artboard, a wrong height, and an artboard that already follows its page", async () => {
    const page = (await (await createPage([{ file: "landing.html" }, { file: "article.html", height: "fit" }])).json()) as Page;
    expect((await fit(page, { file: "missing.html", height: 2000 })).status).toBe(404);
    expect((await fit(page, { file: "landing.html", height: -3 })).status).toBe(400);
    expect((await fit(page, { file: "landing.html", height: 1e9 })).status).toBe(400);
    expect((await fit(page, { file: "landing.html" })).status).toBe(400);
    expect((await fit(page, { file: "article.html", height: 2000 })).status).toBe(400);
  });

  it("refuses a responsive artboard, which has no single height", async () => {
    const page = (await (await createPage([{ file: "landing.html", responsive: ["desktop", "mobile"] }])).json()) as Page;
    expect((await fit(page, { file: "landing.html", height: 2000 })).status).toBe(400);
  });

  it("refuses while a session works on the page", async () => {
    const page = (await (await createPage([{ file: "landing.html" }])).json()) as Page;
    const agent = await server.connectAgent({ projectId: project.id });
    await agent.hello;
    await server.post(`/api/pages/${page.id}/threads`, { artboard: "landing.html", selector: "h1", xPct: 10, yPct: 10, body: "Busy" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const res = await fit(page, { file: "landing.html", height: 2000 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Landing/);
  });
});
