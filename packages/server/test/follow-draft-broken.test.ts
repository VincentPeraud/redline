import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type BrokenPagesAnswer, type DesignSystem, type Page, type ProjectDesignSystem, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: `Board ${i + 1}`, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("turning on the draft when pages break", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const put = (projectId: string, body: unknown) =>
    fetch(`${server.url}/api/projects/${projectId}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const detail = async (projectId: string) => (await (await server.get(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem;
  const threadsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];

  /** Diffusion 1 has ui-badge and --soft; the draft removes both. */
  async function setup(pageBody: string) {
    const ds = (await (await server.post("/api/design-systems", {
      title: "Acme DS",
      files: { "tokens.css": tokensCss("  --soft: #eee;\n"), "manifest.json": manifestOf(["components/badge.html"]), "components/badge.html": componentFile(`<span><slot></slot></span>`) },
    })).json()) as DesignSystem;
    await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) }, message: "Remove", origin: "thread", confirmRemovals: true });
    const project = (await (await server.post("/api/projects", { title: "Acme", designSystem: ds.id })).json()) as { id: string };
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Login", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(pageBody) } })).json()) as Page;
    return { projectId: project.id, page };
  }

  it("answers the broken pages and switches nothing without confirmation", async () => {
    const { projectId, page } = await setup(`<ui-badge>x</ui-badge><i style="color:var(--soft)"></i>`);
    const response = await put(projectId, { followsDraft: true });
    expect(response.status).toBe(409);
    const answer = (await response.json()) as BrokenPagesAnswer;
    expect(answer.brokenPages).toMatchObject([
      { pageId: page.id, title: "Login", artboard: "a.html", elements: [{ kind: "component", name: "ui-badge", blocksPublishing: true, places: [{ artboard: "Board 1", instances: 1 }] }, { kind: "token", name: "--soft", blocksPublishing: false }] },
    ]);
    expect((await detail(projectId)).followsDraft).toBe(false);
    expect(await threadsOf(page)).toEqual([]);
  });

  it("switches on confirmation and opens one thread per affected page", async () => {
    const { projectId, page } = await setup(`<ui-badge>x</ui-badge><i style="color:var(--soft)"></i>`);
    const response = await put(projectId, { followsDraft: true, confirm: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectDesignSystem).followsDraft).toBe(true);
    const threads = await threadsOf(page);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ title: "Retrait dans le design system" });
    expect(threads[0].body).toContain("ui-badge");
    expect(threads[0].body).toContain("--soft");
  });

  it("switches at once, with no thread, when nothing the pages use is removed", async () => {
    const { projectId, page } = await setup(`<p>plain</p>`);
    const response = await put(projectId, { followsDraft: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectDesignSystem).followsDraft).toBe(true);
    expect(await threadsOf(page)).toEqual([]);
  });
});
