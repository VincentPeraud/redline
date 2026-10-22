import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, NEUTRAL_DESIGN_SYSTEM_ID, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";

function tokensCss(overrides: Record<string, string> = {}, omit: string[] = []): string {
  const lines = CORE_TOKENS.filter((t) => !omit.includes(t)).map((t) => `  ${t}: ${overrides[t] ?? "#000"};`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}

describe("design systems over the server HTTP API", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createPage(manifest?: object): Promise<Page> {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    const files: Record<string, string> = { "a.html": html };
    if (manifest) files["manifest.json"] = JSON.stringify(manifest);
    const res = await server.post(`/api/projects/${project.id}/pages`, { title: "Flow", files });
    return (await res.json()) as Page;
  }

  async function createDesignSystem(overrides: Record<string, string> = {}): Promise<DesignSystem> {
    const res = await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss(overrides) },
    });
    return (await res.json()) as DesignSystem;
  }

  const artboard = (page: Page) => fetch(`${server.artboardOrigin}/pages/${page.id}/a.html`).then((r) => r.text());
  const tokens = (id: string) => fetch(`${server.artboardOrigin}/design-systems/${id}/tokens.css`);

  it("seeds a neutral design system defining every core token", async () => {
    const list = (await (await server.get("/api/design-systems")).json()) as DesignSystem[];
    expect(list.map((d) => d.id)).toContain(NEUTRAL_DESIGN_SYSTEM_ID);
    const css = await (await tokens(NEUTRAL_DESIGN_SYSTEM_ID)).text();
    for (const token of CORE_TOKENS) expect(css).toContain(`${token}:`);
  });

  it("does not list design systems among projects", async () => {
    const projects = (await (await server.get("/api/projects")).json()) as { id: string }[];
    expect(projects).toEqual([]);
  });

  it("renders a page with the tokens of its design system, the neutral one by default", async () => {
    const page = await createPage();
    expect(await artboard(page)).toContain(`/design-systems/${NEUTRAL_DESIGN_SYSTEM_ID}/tokens.css`);

    const ds = await createDesignSystem();
    const other = await createPage({ designSystem: ds.id, artboards: [{ file: "a.html" }] });
    expect(await artboard(other)).toContain(`/design-systems/${ds.id}/tokens.css`);
  });

  it("applies a new design system version to every page using it without a new page version", async () => {
    const ds = await createDesignSystem({ "--color-primary": "#111111" });
    const page = await createPage({ designSystem: ds.id, artboards: [{ file: "a.html" }] });
    const before = ((await (await server.get(`/api/pages/${page.id}`)).json()) as Page).version.id;

    const res = await server.post(`/api/pages/${ds.pageId}/versions`, {
      files: { "tokens.css": tokensCss({ "--color-primary": "#ff0000" }) },
      message: "New primary",
      origin: "thread",
    });
    expect(res.status).toBe(201);

    expect(await (await tokens(ds.id)).text()).toContain("--color-primary: #ff0000");
    expect(((await (await server.get(`/api/pages/${page.id}`)).json()) as Page).version.id).toBe(before);
  });

  it("rejects a design system missing a core token at creation and at publish", async () => {
    const bad = await server.post("/api/design-systems", {
      title: "Bad",
      files: { "tokens.css": tokensCss({}, ["--font-heading"]) },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("--font-heading");

    const list = (await (await server.get("/api/design-systems")).json()) as DesignSystem[];
    const neutral = list.find((d) => d.id === NEUTRAL_DESIGN_SYSTEM_ID)!;
    const res = await server.post(`/api/pages/${neutral.pageId}/versions`, {
      files: { "tokens.css": tokensCss({}, ["--color-primary"]) },
      message: "Oops",
      origin: "thread",
    });
    expect(res.status).toBe(400);
  });

  it("announces a new design system version to the pages that use it, and only to them", async () => {
    const ds = await createDesignSystem();
    const using = await createPage({ designSystem: ds.id, artboards: [{ file: "a.html" }] });
    const other = await createPage();
    const frames: string[] = [];
    const abort = new AbortController();
    const reader = (await fetch(server.url + "/api/events", { signal: abort.signal })).body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        frames.push(decoder.decode(value));
      }
    })().catch(() => undefined);

    await server.post(`/api/pages/${ds.pageId}/versions`, {
      files: { "tokens.css": tokensCss({ "--color-primary": "#f00" }) },
      message: "Warmer",
      origin: "thread",
    });
    for (let i = 0; i < 100 && !frames.join("").includes("design-system-updated"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();

    const frame = frames.join("").split("\n\n").find((f) => f.includes("design-system-updated"))!;
    const event = JSON.parse(frame.slice(frame.indexOf("{"))) as { designSystemId: string; pageIds: string[] };
    expect(event.designSystemId).toBe(ds.id);
    expect(event.pageIds).toEqual([using.id]);
    expect(event.pageIds).not.toContain(other.id);
  });

  it("includes the design system files in the working copy", async () => {
    const page = await createPage();
    const copy = (await (await server.get(`/api/pages/${page.id}/working-copy`)).json()) as {
      files: Record<string, string>;
      designSystem: { id: string; files: Record<string, string> };
    };
    expect(copy.files["a.html"]).toBe(html);
    expect(copy.designSystem.id).toBe(NEUTRAL_DESIGN_SYSTEM_ID);
    expect(copy.designSystem.files["tokens.css"]).toContain("--color-primary");
  });
});
