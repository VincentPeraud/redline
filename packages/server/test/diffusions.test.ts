import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, NEUTRAL_DESIGN_SYSTEM_ID, type DesignSystem, type DesignSystemDetail, type DiffusionInfo, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { Store } from "../src/store.js";

const tokensCss = (primary: string, extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n${extra}}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("diffusions: projects follow the diffused version of a design system", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const artboardGet = (path: string) => fetch(`${server.artboardOrigin}${path}`);
  const detailOf = async (id: string) => (await (await server.get(`/api/design-systems/${id}`)).json()) as DesignSystemDetail;

  async function createDesignSystem(): Promise<{ ds: DesignSystem; page: Page }> {
    const ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss("#111111"),
        "manifest.json": manifestOf(["components/button.html"]),
        "components/button.html": component(".btn{color:red}"),
      },
    })).json()) as DesignSystem;
    const page = (await (await server.get(`/api/projects/${ds.id}/pages`)).json() as Page[])[0];
    return { ds, page };
  }

  /** A project page using `ds`, and the page URL path on the artboard origin. */
  async function projectPageUsing(ds: DesignSystem): Promise<string> {
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
      title: "Home",
      files: { "index.html": "<!doctype html><html><head></head><body>Hi</body></html>", "manifest.json": manifestOf(["index.html"], ds.id) },
    })).json()) as Page;
    return `/pages/${page.id}/index.html`;
  }

  const publish = (page: Page, files: Record<string, string>) => server.post(`/api/pages/${page.id}/versions`, { files, message: "Edit", origin: "thread" });
  const hrefOf = (markup: string, file: string) => new RegExp(`href="([^"]*${file})"`).exec(markup)?.[1] ?? "";

  it("gives a new design system diffusion 1 with nothing pending", async () => {
    const { ds } = await createDesignSystem();
    const detail = await detailOf(ds.id);
    expect(detail.current.number).toBe(1);
    expect(detail.pending.count).toBe(0);
    expect(detail.pages.map((p) => p.title)).toEqual(["Acme DS"]);
    expect(((await (await server.get(`/api/design-systems/${ds.id}/diffusions`)).json()) as DiffusionInfo[]).map((d) => d.number)).toEqual([1]);
  });

  it("answers 404 for an unknown design system", async () => {
    expect((await server.get("/api/design-systems/nope")).status).toBe(404);
    expect((await server.post("/api/design-systems/nope/diffusions", {})).status).toBe(404);
  });

  it("shows an edit on the design system's own pages at once, and on no project until a diffusion", async () => {
    const { ds, page } = await createDesignSystem();
    const projectPage = await projectPageUsing(ds);

    const files = { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component(".btn{color:blue}") };
    expect((await publish(page, files)).status).toBe(201);

    // The design system's page reads the draft ...
    const dsPage = (await (await server.get(`/api/projects/${ds.id}/pages`)).json() as Page[])[0];
    const dsMarkup = await (await artboardGet(`/pages/${dsPage.id}/components/button.html`)).text();
    expect(await (await artboardGet(hrefOf(dsMarkup, "tokens.css"))).text()).toContain("--color-primary: #222222");
    expect(await (await artboardGet(hrefOf(dsMarkup, "components.css"))).text()).toContain("color:blue");

    // ... a project page still reads diffusion 1.
    const markup = await (await artboardGet(projectPage)).text();
    expect(hrefOf(markup, "tokens.css")).toBe(`/design-systems/${ds.id}/diffusions/1/tokens.css`);
    expect(await (await artboardGet(hrefOf(markup, "tokens.css"))).text()).toContain("--color-primary: #111111");
    expect(await (await artboardGet(`/design-systems/${ds.id}/diffusions/1/components.css`)).text()).toContain("color:red");

    const detail = await detailOf(ds.id);
    expect(detail.current.number).toBe(1);
    expect(detail.pending.tokens.changed).toEqual([{ name: "--color-primary", from: "#111111", to: "#222222" }]);
    expect(detail.pending.components.changed).toEqual(["button"]);
  });

  it("creates a diffusion from the draft: it returns its number and projects then get it, older ones stay unchanged", async () => {
    const { ds, page } = await createDesignSystem();
    const projectPage = await projectPageUsing(ds);
    await publish(page, { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component(".btn{color:blue}") });

    const res = await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    expect(res.status).toBe(201);
    const created = (await res.json()) as DiffusionInfo;
    expect(created.number).toBe(2);
    expect(created.origin).toBe("user");
    expect(created.summary).toBe("1 token changed, 1 component changed");

    const markup = await (await artboardGet(projectPage)).text();
    expect(hrefOf(markup, "tokens.css")).toBe(`/design-systems/${ds.id}/diffusions/2/tokens.css`);
    expect(await (await artboardGet(hrefOf(markup, "tokens.css"))).text()).toContain("--color-primary: #222222");
    expect(await (await artboardGet(hrefOf(markup, "components.css"))).text()).toContain("color:blue");
    expect(await (await artboardGet(`/design-systems/${ds.id}/diffusions/1/tokens.css`)).text()).toContain("--color-primary: #111111");

    const detail = await detailOf(ds.id);
    expect(detail.current.number).toBe(2);
    expect(detail.pending.count).toBe(0);
    expect(((await (await server.get(`/api/design-systems/${ds.id}/diffusions`)).json()) as DiffusionInfo[]).map((d) => d.number)).toEqual([2, 1]);
  });

  it("lists the projects whose own style overrides a pending token change", async () => {
    const { ds, page } = await createDesignSystem();
    const halloween = (await (await server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as { id: string };
    const plain = (await (await server.post("/api/projects", { title: "Plain", designSystem: ds.id })).json()) as { id: string };
    const putStyle = (id: string, content: string) =>
      fetch(`${server.url}/api/projects/${id}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
    await putStyle(halloween.id, ":root { --color-primary: #ff6600; --color-other: #123456; }");
    await putStyle(plain.id, ":root { --color-other: #123456; }");

    expect((await detailOf(ds.id)).overrides).toEqual([]);
    await publish(page, { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component(".btn{color:red}") });
    expect((await detailOf(ds.id)).overrides).toEqual([{ id: halloween.id, title: "Halloween", tokens: ["--color-primary"] }]);
  });

  it("previews a component before (current diffusion) and after (draft) a pending change", async () => {
    const { ds, page } = await createDesignSystem();
    await publish(page, { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component(".btn{color:blue}") });

    const after = await (await artboardGet(`/design-systems/${ds.id}/component-previews/button`)).text();
    expect(hrefOf(after, "tokens.css")).toBe(`/design-systems/${ds.id}/tokens.css`);
    const before = await (await artboardGet(`/design-systems/${ds.id}/component-previews/button?diffusion=1`)).text();
    expect(hrefOf(before, "tokens.css")).toBe(`/design-systems/${ds.id}/diffusions/1/tokens.css`);
    expect(after).not.toContain("color:blue");
    expect(before).not.toContain("color:blue");
    expect((await artboardGet(`/design-systems/${ds.id}/component-previews/nope`)).status).toBe(404);
  });

  it("tells in the design systems list how many changes are pending, until a diffusion", async () => {
    const { ds, page } = await createDesignSystem();
    const pendingOf = async () =>
      ((await (await server.get("/api/design-systems")).json()) as { id: string; pendingChanges: number }[]).find((d) => d.id === ds.id)!.pendingChanges;
    expect(await pendingOf()).toBe(0);
    await publish(page, { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/button.html"]), "components/button.html": component(".btn{color:red}") });
    expect(await pendingOf()).toBe(1);
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    expect(await pendingOf()).toBe(0);
  });

  it("refuses a diffusion when nothing is pending", async () => {
    const { ds } = await createDesignSystem();
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(409);
  });

  it("makes DESIGN.md part of the diffusion", async () => {
    const { ds } = await createDesignSystem();
    await fetch(`${server.url}/api/projects/${ds.id}/design-md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# New rules" }) });
    expect((await detailOf(ds.id)).pending.designMdChanged).toBe(true);
    expect(((await (await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).json()) as DiffusionInfo).summary).toBe("DESIGN.md changed");
    expect((await detailOf(ds.id)).pending.count).toBe(0);
  });

  it("has no diffusion endpoint reachable by Claude's agent API", async () => {
    const { ds } = await createDesignSystem();
    expect((await server.post(`/agent-api/design-systems/${ds.id}/diffusions`, {})).status).toBe(404);
  });

  it("serves 404 for an unknown diffusion file", async () => {
    const { ds } = await createDesignSystem();
    expect((await artboardGet(`/design-systems/${ds.id}/diffusions/9/tokens.css`)).status).toBe(404);
    expect((await artboardGet(`/design-systems/${ds.id}/diffusions/1/other.css`)).status).toBe(404);
  });
});

describe("migration: existing design systems get diffusion 1", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "redline-diffusion-migration-"));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("builds diffusion 1 from the current files, once", () => {
    const seed = new Store(dataDir);
    const custom = seed.createDesignSystem("Custom", { "tokens.css": tokensCss("#abcdef"), "index.html": "<html></html>" });
    seed.close();
    const db = new Database(join(dataDir, "redline.db"));
    db.exec("DELETE FROM design_system_diffusions; UPDATE design_systems SET current_diffusion = NULL");
    db.close();

    const store = new Store(dataDir);
    expect(store.listDiffusions(custom.id).map((d) => [d.number, d.origin])).toEqual([[1, "migration"]]);
    expect(store.listDiffusions(NEUTRAL_DESIGN_SYSTEM_ID).map((d) => d.number)).toEqual([1]);
    expect(store.readDiffusionFile(custom.id, 1, "tokens.css")).toContain("--color-primary: #abcdef");
    store.close();

    const again = new Store(dataDir);
    expect(again.listDiffusions(custom.id)).toHaveLength(1);
    again.close();
  });
});
