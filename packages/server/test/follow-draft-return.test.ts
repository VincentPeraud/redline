import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, type BrokenPagesAnswer, type DesignMdVersion, type DesignSystem, type Page, type ProjectDesignSystem, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: `Board ${i + 1}`, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("going back to the latest diffusion", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const put = (projectId: string, body: unknown) => send("PUT", `/api/projects/${projectId}/design-system`, body);
  const detail = async (projectId: string) => (await (await server.get(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem;
  const threadsOf = async (page: Page) => (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  const publishDraft = (ds: DesignSystem, extra: string, files: string[] = []) =>
    server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss(extra), "manifest.json": manifestOf(files), ...Object.fromEntries(files.map((f) => [f, componentFile("<span><slot></slot></span>")])) }, message: "Draft", origin: "thread", confirmRemovals: true });
  const newProject = async (ds: DesignSystem, title = "Acme") => ((await (await server.post("/api/projects", { title, designSystem: ds.id })).json()) as { id: string }).id;
  const newPage = async (projectId: string, ds: DesignSystem, body: string) =>
    (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Login", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(body) } })).json()) as Page;
  const designSystem = async (extra = "") =>
    (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss(extra), "manifest.json": manifestOf([]) } })).json()) as DesignSystem;

  /** The draft adds ui-badge; a project on the draft uses it, so going back breaks its page. */
  async function onDraftWithBadge() {
    const ds = await designSystem();
    await publishDraft(ds, "", ["components/badge.html"]);
    const projectId = await newProject(ds);
    expect((await put(projectId, { followsDraft: true })).status).toBe(200);
    const page = await newPage(projectId, ds, `<ui-badge>x</ui-badge>`);
    return { ds, projectId, page };
  }

  it("always answers, without changing anything, and says who receives a diffusion", async () => {
    const ds = await designSystem();
    await publishDraft(ds, "  --extra: #eee;\n");
    const projectId = await newProject(ds);
    await newProject(ds, "Site public");
    await put(projectId, { followsDraft: true });
    const response = await put(projectId, { followsDraft: false });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ brokenPages: [], otherProjects: ["Site public"], canDiffuse: true });
    expect((await detail(projectId)).followsDraft).toBe(true);
  });

  it("lists the pages that would break", async () => {
    const { projectId, page } = await onDraftWithBadge();
    const answer = (await (await put(projectId, { followsDraft: false })).json()) as BrokenPagesAnswer;
    expect(answer.brokenPages).toMatchObject([{ pageId: page.id, elements: [{ kind: "component", name: "ui-badge" }] }]);
  });

  it("switches back on confirmation and opens one thread per affected page", async () => {
    const { projectId, page } = await onDraftWithBadge();
    const response = await put(projectId, { followsDraft: false, confirm: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProjectDesignSystem).followsDraft).toBe(false);
    const threads = await threadsOf(page);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ title: "Retour à la dernière diffusion", automatic: true });
    expect(threads[0].body).toContain("ui-badge");
  });

  it("opens no thread when nothing breaks", async () => {
    const ds = await designSystem();
    await publishDraft(ds, "  --extra: #eee;\n");
    const projectId = await newProject(ds);
    const page = await newPage(projectId, ds, `<p>plain</p>`);
    await put(projectId, { followsDraft: true });
    expect((await put(projectId, { followsDraft: false, confirm: true })).status).toBe(200);
    expect(await threadsOf(page)).toEqual([]);
  });

  it("replies in an open removal thread for the same elements instead of opening a second one", async () => {
    const ds = await designSystem("  --soft: #eee;\n");
    const projectId = await newProject(ds);
    const page = await newPage(projectId, ds, `<i style="color:var(--soft)"></i>`);
    await publishDraft(ds, "");
    await put(projectId, { followsDraft: true, confirm: true });
    expect((await threadsOf(page)).map((t) => t.title)).toEqual(["Retrait dans le design system"]);
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    await publishDraft(ds, "  --soft: #eee;\n");

    await put(projectId, { followsDraft: false, confirm: true });
    const threads = await threadsOf(page);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.at(-1)).toMatchObject({ author: "redline" });
    expect(threads[0].replies.at(-1)!.body).toContain("--soft");
  });

  describe("Diffuser d'abord", () => {
    const intent = (projectId: string, method = "POST") => send(method, `/api/projects/${projectId}/design-system/return-after-diffusion`);
    const history = async (projectId: string) => (await (await server.get(`/api/projects/${projectId}/project-style/versions`)).json()) as DesignMdVersion[];

    async function pending() {
      const ds = await designSystem();
      const projectId = await newProject(ds);
      await put(projectId, { followsDraft: true });
      await publishDraft(ds, "  --extra: #eee;\n");
      return { ds, projectId };
    }

    it("switches the project back once the diffusion succeeds, and logs it", async () => {
      const { ds, projectId } = await pending();
      expect((await intent(projectId)).status).toBe(200);
      expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(201);
      expect((await detail(projectId)).followsDraft).toBe(false);
      expect((await history(projectId))[0].setting).toMatchObject({ follows: "diffusion" });
    });

    it("does nothing to a project that did not ask for it", async () => {
      const { ds, projectId } = await pending();
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await detail(projectId)).followsDraft).toBe(true);
    });

    it("is dropped when the review closes without diffusing", async () => {
      const { ds, projectId } = await pending();
      await intent(projectId);
      expect((await intent(projectId, "DELETE")).status).toBe(200);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await detail(projectId)).followsDraft).toBe(true);
    });

    it("is dropped when the project no longer follows the draft", async () => {
      const { ds, projectId } = await pending();
      await intent(projectId);
      await put(projectId, { followsDraft: false, confirm: true });
      await put(projectId, { followsDraft: true });
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await detail(projectId)).followsDraft).toBe(true);
    });

    it("is refused for a project that follows the diffusion", async () => {
      const ds = await designSystem();
      const projectId = await newProject(ds);
      expect((await intent(projectId)).status).toBe(409);
    });

    it("joins a diffusion started by someone else: every project that asked goes back", async () => {
      const { ds, projectId } = await pending();
      const other = await newProject(ds, "Other");
      await put(other, { followsDraft: true });
      await intent(projectId);
      await intent(other);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await detail(projectId)).followsDraft).toBe(false);
      expect((await detail(other)).followsDraft).toBe(false);
    });
  });
});
