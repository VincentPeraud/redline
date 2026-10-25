import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, NEUTRAL_DESIGN_SYSTEM_ID, type DesignMdVersion, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { Store } from "../src/store.js";
import { startServer } from "../src/start.js";

const html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";

function tokensCss(overrides: Record<string, string> = {}, omit: string[] = []): string {
  const lines = CORE_TOKENS.filter((t) => !omit.includes(t)).map((t) => `  ${t}: ${overrides[t] ?? "#000"};`);
  return `:root {\n${lines.join("\n")}\n}\n`;
}

describe("a design system with several pages", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  async function createDesignSystem(files: Record<string, string> = { "tokens.css": tokensCss(), "buttons.html": html }): Promise<DesignSystem> {
    return (await (await server.post("/api/design-systems", { title: "Acme DS", files })).json()) as DesignSystem;
  }
  const pagesOf = async (id: string) => (await (await server.get(`/api/projects/${id}/pages`)).json()) as Page[];
  const tokensOf = (id: string) => fetch(`${server.artboardOrigin}/design-systems/${id}/tokens.css`);
  const tokenVersions = async (id: string) => (await (await server.get(`/api/design-systems/${id}/tokens/versions`)).json()) as DesignMdVersion[];

  it("accepts any number of freely named pages", async () => {
    const ds = await createDesignSystem();
    for (const title of ["Forms", "Navigation & menus", "Feedback"]) {
      const res = await server.post(`/api/projects/${ds.id}/pages`, { title, files: { "a.html": html } });
      expect(res.status).toBe(201);
    }
    expect((await pagesOf(ds.id)).map((p) => p.title)).toEqual(["Acme DS", "Forms", "Navigation & menus", "Feedback"]);
  });

  it("keeps tokens.css at the project level, not in any page", async () => {
    const ds = await createDesignSystem({ "tokens.css": tokensCss({ "--color-primary": "#123456" }), "buttons.html": html });
    const [first] = await pagesOf(ds.id);
    expect(Object.keys(first.version.files)).toEqual(["buttons.html"]);
    expect(await (await tokensOf(ds.id)).text()).toContain("--color-primary: #123456");
  });

  it("applies tokens published through any page of the design system, and versions them", async () => {
    const ds = await createDesignSystem({ "tokens.css": tokensCss({ "--color-primary": "#111111" }), "a.html": html });
    const other = (await (await server.post(`/api/projects/${ds.id}/pages`, { title: "Forms", files: { "b.html": html } })).json()) as Page;
    const res = await server.post(`/api/pages/${other.id}/versions`, {
      files: { "b.html": html, "tokens.css": tokensCss({ "--color-primary": "#ff0000" }) },
      message: "Warmer",
      origin: "thread",
    });
    expect(res.status).toBe(201);
    expect(await (await tokensOf(ds.id)).text()).toContain("--color-primary: #ff0000");
    const versions = await tokenVersions(ds.id);
    expect(versions.map((v) => v.content.includes("#ff0000"))).toEqual([true, false]);
    expect(((await (await server.get(`/api/pages/${other.id}`)).json()) as Page).version.files).not.toHaveProperty("tokens.css");
  });

  it("refuses to remove a core token, from any page", async () => {
    const ds = await createDesignSystem();
    const other = (await (await server.post(`/api/projects/${ds.id}/pages`, { title: "Forms", files: { "b.html": html } })).json()) as Page;
    for (const pageId of [(await pagesOf(ds.id))[0].id, other.id]) {
      const res = await server.post(`/api/pages/${pageId}/versions`, {
        files: { "tokens.css": tokensCss({}, ["--radius"]) },
        message: "Oops",
        origin: "thread",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("--radius");
    }
    expect(await (await tokensOf(ds.id)).text()).toContain("--radius");
  });

  it("refuses a tokens.css without the core tokens, published from any page", async () => {
    const ds = await createDesignSystem();
    const other = (await (await server.post(`/api/projects/${ds.id}/pages`, { title: "Forms", files: { "b.html": html } })).json()) as Page;
    const res = await server.post(`/api/pages/${other.id}/versions`, { files: { "tokens.css": "body {}" }, message: "x", origin: "thread" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Missing core tokens");
  });

  it("serves the design system's DESIGN.md as a project-level versioned file", async () => {
    const ds = await createDesignSystem();
    await fetch(`${server.url}/api/projects/${ds.id}/design-md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "- Buttons are rounded" }),
    });
    const versions = (await (await server.get(`/api/projects/${ds.id}/design-md/versions`)).json()) as DesignMdVersion[];
    expect(versions.map((v) => v.content)).toEqual(["- Buttons are rounded"]);
    expect(await tokenVersions(ds.id)).toHaveLength(1);
  });
});

describe("migration of existing design systems", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-migration-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  /** Rewrites a design system as it was stored before tokens became project-level: tokens.css inside its page. */
  function makeLegacy(id: string): string {
    const db = new Database(join(dataDir, "redline.db"));
    const tokensHash = (db.prepare("SELECT hash FROM project_files WHERE project_id = ? AND path = 'tokens.css'").get(id) as { hash: string }).hash;
    const { page_id: pageId } = db.prepare("SELECT page_id FROM design_systems WHERE project_id = ?").get(id) as { page_id: string };
    const latest = db.prepare("SELECT files FROM versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC").get(pageId) as { files: string };
    const files = { ...(JSON.parse(latest.files) as Record<string, string>), "tokens.css": tokensHash };
    db.prepare("INSERT INTO versions (id, page_id, files, created_at, message, origin) VALUES (?, ?, ?, ?, 'legacy', 'thread')").run(
      `legacy-${id}`,
      pageId,
      JSON.stringify(files),
      new Date().toISOString(),
    );
    db.prepare("DELETE FROM project_files WHERE project_id = ? AND path = 'tokens.css'").run(id);
    db.prepare("DELETE FROM design_md_versions WHERE project_id = ? AND hash = ?").run(id, tokensHash);
    db.close();
    return tokensHash;
  }

  it("moves tokens.css of the page to the project level and keeps the other page files", async () => {
    const seed = new Store(dataDir);
    const custom = seed.createDesignSystem("Custom", { "tokens.css": tokensCss({ "--color-primary": "#abcdef" }), "index.html": html, "extra.css": "a{}" });
    const customTokens = seed.readProjectFile(custom.id, "tokens.css")!.toString("utf8");
    const neutralTokens = seed.readProjectFile(NEUTRAL_DESIGN_SYSTEM_ID, "tokens.css")!.toString("utf8");
    seed.close();
    makeLegacy(custom.id);
    makeLegacy(NEUTRAL_DESIGN_SYSTEM_ID);

    const store = new Store(dataDir);
    expect(store.readProjectFile(custom.id, "tokens.css")?.toString("utf8")).toBe(customTokens);
    expect(store.readProjectFile(NEUTRAL_DESIGN_SYSTEM_ID, "tokens.css")?.toString("utf8")).toBe(neutralTokens);
    const [page] = store.listPages(custom.id);
    expect(Object.keys(page.version.files).sort()).toEqual(["extra.css", "index.html"]);
    expect(store.listDesignMdVersions(custom.id, "tokens.css")).toHaveLength(1);
    store.close();

    // Reopening again changes nothing.
    const again = new Store(dataDir);
    expect(again.listDesignMdVersions(custom.id, "tokens.css")).toHaveLength(1);
    expect(again.listVersions(again.listPages(custom.id)[0].id)).toHaveLength(3);
    again.close();
  });

  it("serves the same tokens to artboards after the migration", async () => {
    const seed = new Store(dataDir);
    seed.close();
    const before = await serveTokens();
    makeLegacy(NEUTRAL_DESIGN_SYSTEM_ID);
    expect(await serveTokens()).toBe(before);
    expect(before).toContain("--color-primary");
  });

  async function serveTokens(): Promise<string> {
    const running = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1" });
    try {
      return await (await fetch(`${running.artboardOrigin}/design-systems/${NEUTRAL_DESIGN_SYSTEM_ID}/tokens.css`)).text();
    } finally {
      await running.close();
    }
  }
});
