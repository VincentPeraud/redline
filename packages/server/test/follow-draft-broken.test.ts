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

  describe("what counts as broken", () => {
    const BADGE = componentFile(`<span><slot></slot></span>`);
    const MODAL = componentFile(`<div><h2><slot name="title"></slot></h2><slot></slot></div>`);
    const sizeTweak = (options: string[]) => ({ id: "size", type: "choice", label: "Size", options, default: options[0], artboard: "components/modal.html" });
    const dsManifest = (files: string[], options: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [sizeTweak(options)] });

    /** Diffusion 1 has ui-badge, ui-modal (size sm/lg, title slot) and --accent-soft; `draft` is what the draft publishes next. */
    async function acme(draft: { tokens: string; files: string[]; sizes: string[]; extra?: Record<string, string> }) {
      const created = (await (await server.post("/api/design-systems", {
        title: "Acme DS",
        files: { "tokens.css": tokensCss("  --accent-soft: #eee;\n  --keep: #111;\n"), "manifest.json": dsManifest(["components/badge.html", "components/modal.html"], ["sm", "lg"]), "components/badge.html": BADGE, "components/modal.html": MODAL },
      })).json()) as DesignSystem;
      const published = await server.post(`/api/pages/${created.pageId}/versions`, {
        files: { "tokens.css": draft.tokens, "manifest.json": dsManifest(draft.files, draft.sizes), "components/modal.html": MODAL, ...draft.extra },
        message: "Draft",
        origin: "thread",
        confirmRemovals: true,
      });
      expect(published.status).toBe(201);
      const project = (await (await server.post("/api/projects", { title: "Acme", designSystem: created.id })).json()) as { id: string };
      return { ds: created, projectId: project.id };
    }
    const pageWith = async (ds: DesignSystem, projectId: string, title: string, body: string) =>
      (await (await server.post(`/api/projects/${projectId}/pages`, { title, files: { "manifest.json": manifestOf(["a.html", "b.html"], ds.id), "a.html": mockup(body), "b.html": mockup("<p>nothing</p>") } })).json()) as Page;
    const brokenOf = async (projectId: string) => ((await (await put(projectId, { followsDraft: true })).json()) as Partial<BrokenPagesAnswer>).brokenPages ?? [];

    it("lists, per page and artboard, a removed component, value and slot as blocking and a missing token as not blocking", async () => {
      const { ds, projectId } = await acme({ tokens: tokensCss("  --keep: #111;\n"), files: ["components/modal.html"], sizes: ["sm"] });
      const login = await pageWith(ds, projectId, "Login", `<ui-badge>a</ui-badge><ui-badge>b</ui-badge><ui-modal size="lg"><span slot="title">T</span></ui-modal><i style="color:var(--accent-soft)"></i>`);
      await pageWith(ds, projectId, "Other", `<p style="color:var(--keep)">fine</p>`);
      const broken = await brokenOf(projectId);
      expect(broken).toHaveLength(1);
      expect(broken[0]).toMatchObject({ pageId: login.id, title: "Login", artboard: "a.html" });
      const byName = Object.fromEntries(broken[0].elements.map((e) => [`${e.kind}:${e.name}`, e]));
      expect(byName["component:ui-badge"]).toMatchObject({ blocksPublishing: true, places: [{ artboard: "Board 1", instances: 2 }] });
      expect(byName["value:ui-modal"]).toMatchObject({ setting: "size", value: "lg", blocksPublishing: true });
      expect(byName["token:--accent-soft"]).toMatchObject({ blocksPublishing: false, places: [{ artboard: "Board 1" }] });
      expect(broken[0].elements).toHaveLength(3);
    });

    it("names the token a missing one was renamed to, when the draft has one new token of the same value", async () => {
      const { ds, projectId } = await acme({ tokens: tokensCss("  --accent-subtle: #eee;\n  --keep: #111;\n"), files: ["components/badge.html", "components/modal.html"], sizes: ["sm", "lg"], extra: { "components/badge.html": BADGE } });
      await pageWith(ds, projectId, "Login", `<i style="color:var(--accent-soft)"></i>`);
      expect((await brokenOf(projectId))[0].elements).toMatchObject([{ kind: "token", name: "--accent-soft", renamedTo: "--accent-subtle" }]);
    });

    it("does not count a token the project style defines itself, nor a component the project defines", async () => {
      const { ds, projectId } = await acme({ tokens: tokensCss("  --keep: #111;\n"), files: ["components/modal.html"], sizes: ["sm", "lg"] });
      await put(`/api/projects/${projectId}/project-style/tokens/--accent-soft`, { value: "#fff" });
      await server.post(`/api/projects/${projectId}/pages`, {
        title: "Own",
        files: { "manifest.json": manifestOf(["components/badge.html", "a.html"], ds.id), "components/badge.html": BADGE, "a.html": mockup(`<ui-badge>x</ui-badge><i style="color:var(--accent-soft)"></i>`) },
      });
      expect(await brokenOf(projectId)).toEqual([]);
    });

    it("goes the other way: what the draft has and the diffusion lacks, used by a page of a project on the draft", async () => {
      const { ds, projectId } = await acme({
        tokens: tokensCss("  --accent-soft: #eee;\n  --keep: #111;\n  --brand: #123;\n"),
        files: ["components/badge.html", "components/modal.html", "components/card.html"],
        sizes: ["sm", "lg", "xl"],
        extra: { "components/badge.html": BADGE, "components/card.html": componentFile(`<section><slot></slot></section>`) },
      });
      await put(projectId, { followsDraft: true, confirm: true });
      await pageWith(ds, projectId, "Home", `<ui-card>c</ui-card><ui-modal size="xl"></ui-modal><i style="color:var(--brand)"></i>`);
      const answer = (await (await put(projectId, { followsDraft: false })).json()) as BrokenPagesAnswer;
      expect(answer.brokenPages.map((p) => p.title)).toEqual(["Home"]);
      expect(answer.brokenPages[0].elements.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(["component:ui-card", "token:--brand", "value:ui-modal"]);
    });
  });
});
