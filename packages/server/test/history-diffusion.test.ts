import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, versionPreviewPath, type ArtboardVersion, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;
const manifestOf = (designSystem: string) => JSON.stringify({ designSystem, artboards: [{ file: "index.html", x: 0, y: 0, width: 200, height: 100 }] });
const HTML = "<!doctype html><html><head></head><body>Hi</body></html>";

describe("history: a version is drawn with the diffusion current when it was published", () => {
  let server: TestServer;
  let ds: DesignSystem;
  let page: Page;

  beforeEach(async () => {
    server = await startTestServer();
    ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss("#111111"), "index.html": HTML } })).json()) as DesignSystem;
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    page = (await (await server.post(`/api/projects/${project.id}/pages`, {
      title: "Home",
      files: { "index.html": HTML, "manifest.json": manifestOf(ds.id) },
    })).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const publish = async (body: string) => {
    const res = await server.post(`/api/pages/${page.id}/versions`, {
      files: { "index.html": `<!doctype html><html><head></head><body>${body}</body></html>`, "manifest.json": manifestOf(ds.id) },
      message: body,
      origin: "thread",
    });
    expect(res.status).toBe(201);
  };
  const diffuse = async (primary: string) => {
    const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0];
    await server.post(`/api/pages/${dsPage.id}/versions`, { files: { "tokens.css": tokensCss(primary), "index.html": HTML }, message: "Edit", origin: "thread" });
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(201);
  };
  const historyOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/artboard-versions?file=index.html`)).json()) as ArtboardVersion[];
  const previewOf = async (pageId: string, versionId: string) => (await fetch(`${server.artboardOrigin}${versionPreviewPath(pageId, versionId, "index.html")}`)).text();
  const diffusionOfLink = (markup: string) => /design-systems\/[^/]+\/diffusions\/(\d+)\/tokens\.css/.exec(markup)?.[1];

  it("previews a version with the diffusion it was published under, after a newer diffusion", async () => {
    await publish("first");
    await diffuse("#222222");
    await publish("second");
    await diffuse("#333333");

    const [second, first] = (await historyOf(page.id)).map((v) => v.versionId);
    expect(diffusionOfLink(await previewOf(page.id, first))).toBe("1");
    expect(diffusionOfLink(await previewOf(page.id, second))).toBe("2");
  });

  it("labels each history entry with its design system and diffusion", async () => {
    await publish("first");
    await diffuse("#222222");
    await publish("second");

    expect((await historyOf(page.id)).map((v) => v.diffusion)).toEqual([
      { designSystemTitle: "Acme DS", number: 2 },
      { designSystemTitle: "Acme DS", number: 1 },
      { designSystemTitle: "Acme DS", number: 1 },
    ]);
  });

  it("previews versions recorded before the lot with diffusion 1", async () => {
    await publish("first");
    await diffuse("#222222");
    const db = new Database(join(server.dataDir, "redline.db"));
    db.exec("UPDATE versions SET diffusion = NULL");
    db.close();

    const [newest] = await historyOf(page.id);
    expect(newest.diffusion).toEqual({ designSystemTitle: "Acme DS", number: 1 });
    expect(diffusionOfLink(await previewOf(page.id, newest.versionId))).toBe("1");
  });

  it("gives no label to the versions of a design system's own pages, which stay on the draft", async () => {
    const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0];
    const [entry] = await historyOf(dsPage.id);
    expect(entry.diffusion).toBeUndefined();
    const markup = await previewOf(dsPage.id, entry.versionId);
    expect(diffusionOfLink(markup)).toBeUndefined();
    expect(markup).toContain(`/design-systems/${ds.id}/tokens.css`);
  });
});
