import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DesignSystemDetail, type DiffusionListItem, type Page, type RollbackImpact } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111111;`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

describe("undo and roll back a diffusion", () => {
  let server: TestServer;
  let ds: DesignSystem;
  let dsPage: Page;
  let added: string[];
  let files: Record<string, string>;

  beforeEach(async () => {
    server = await startTestServer();
    added = [];
    files = { "components/btn.html": component(".btn{color:red}") };
    ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/btn.html"]), "components/btn.html": component(".btn{color:red}") },
    })).json()) as DesignSystem;
    dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  });
  afterEach(async () => {
    await server.stop();
  });

  const list = async () => (await (await server.get(`/api/design-systems/${ds.id}/diffusions`)).json()) as DiffusionListItem[];
  const detail = async () => (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
  const diffuse = () => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const undo = () => server.post(`/api/design-systems/${ds.id}/diffusions/undo`, {});
  const addComponent = async (name: string, cls: string) => {
    added.push(name);
    files[`components/${name}.html`] = component(`.${cls}{color:blue}`);
    const res = await server.post(`/api/pages/${dsPage.id}/versions`, {
      files: { ...files, "manifest.json": manifestOf(["components/btn.html", ...added.map((n) => `components/${n}.html`)]) },
      message: "Add",
      origin: "thread",
    });
    expect(res.status).toBe(201);
    return res;
  };
  async function projectPageUsing(className: string): Promise<{ css: () => Promise<string> }> {
    const project = (await (await server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as { id: string };
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
      title: "Stories",
      files: { "index.html": `<!doctype html><html><head></head><body><p class="${className}">Hi</p></body></html>`, "manifest.json": manifestOf(["index.html"], ds.id) },
    })).json()) as Page;
    return {
      css: async () => {
        const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/index.html`)).text();
        const href = /href="([^"]*components\.css)"/.exec(html)![1]!;
        return (await fetch(`${server.artboardOrigin}${href}`)).text();
      },
    };
  }

  it("undoes the latest diffusion: back to the previous one, the undone one stays listed as undone", async () => {
    await addComponent("cta", "cta");
    await diffuse();
    const undone = await undo();
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { number: number }).number).toBe(1);
    expect((await detail()).current.number).toBe(1);
    expect((await list()).map((r) => [r.number, r.undone])).toEqual([[2, true], [1, false]]);
    expect((await detail()).pending.count).toBeGreaterThan(0);
  });

  it("numbers the next diffusion after the undone one, and undoing again skips undone diffusions", async () => {
    await addComponent("cta", "cta");
    await diffuse();
    await undo();
    const next = await diffuse();
    expect(((await next.json()) as { number: number }).number).toBe(3);
    await undo();
    expect((await detail()).current.number).toBe(1);
  });

  it("refuses to undo the first diffusion", async () => {
    expect((await undo()).status).toBe(409);
  });

  it("serves projects the files of the previous diffusion after an undo", async () => {
    const { css } = await projectPageUsing("btn");
    await addComponent("cta", "cta");
    await diffuse();
    expect(await css()).toContain(".cta");
    await undo();
    expect(await css()).not.toContain(".cta");
  });

  it("rolls back: projects get that diffusion again as a new entry, nothing deleted, design system pages unchanged", async () => {
    const { css } = await projectPageUsing("btn");
    await addComponent("cta", "cta");
    await diffuse();
    const pageBefore = await (await server.get(`/api/pages/${dsPage.id}`)).text();
    const rolled = await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {});
    expect(rolled.status).toBe(201);
    expect(await rolled.json()).toMatchObject({ number: 3, origin: "rollback", rolledBackTo: 1 });
    expect((await detail()).current.number).toBe(3);
    expect((await list()).map((r) => r.number)).toEqual([3, 2, 1]);
    expect(await css()).not.toContain(".cta");
    expect(await (await server.get(`/api/pages/${dsPage.id}`)).text()).toBe(pageBefore);
    expect((await detail()).pending.components.added).toContain("cta");
  });

  it("refuses to roll back to the current or an unknown diffusion", async () => {
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {})).status).toBe(409);
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions/9/rollback`, {})).status).toBe(404);
  });

  it("warns, before rolling back, about pages using a component added since", async () => {
    await projectPageUsing("btn");
    await projectPageUsing("cta");
    await addComponent("cta", "cta");
    await diffuse();
    await addComponent("unused", "unused");
    await diffuse();
    const impact = (await (await server.get(`/api/design-systems/${ds.id}/diffusions/1/rollback-impact`)).json()) as RollbackImpact;
    expect(impact.components).toEqual([{ name: "cta", usedBy: [{ project: "Halloween", page: "Stories" }] }]);
  });
});
