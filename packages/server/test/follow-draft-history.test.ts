import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_TOKENS, versionPreviewPath, type DesignMdVersion, type DesignSystem, type Page, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { AccountsInstance } from "./accounts-harness.js";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("history of a project that follows the draft", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const designSystem = async () =>
    (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": componentFile("<div><slot></slot></div>") } })).json()) as DesignSystem;
  const addCard = async (ds: DesignSystem) =>
    server.post(`/api/pages/${ds.pageId}/versions`, {
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "components/card.html"]), "components/modal.html": componentFile("<div><slot></slot></div>"), "components/card.html": componentFile("<section><slot></slot></section>") },
      message: "Add a card",
      origin: "thread",
    });
  const project = async (ds: DesignSystem) => ((await (await server.post("/api/projects", { title: "Acme", designSystem: ds.id })).json()) as { id: string }).id;
  const follow = (projectId: string, followsDraft: boolean) => put(`/api/projects/${projectId}/design-system`, { followsDraft });
  const files = (ds: DesignSystem, body: string) => ({ "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(body) });
  const versionsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/artboard-versions?file=a.html`)).json()) as { versionId: string; diffusion?: { onDraft?: boolean } }[];
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

  /** A page published on the draft (it uses the draft-only card), then the project goes back to the diffusion. Returns the page and its draft version. */
  async function pageOnTheDraftThenBack() {
    const ds = await designSystem();
    await addCard(ds);
    const projectId = await project(ds);
    await follow(projectId, true);
    const page = (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: files(ds, "<ui-card>x</ui-card>") })).json()) as Page;
    await server.post(`/api/pages/${page.id}/versions`, { files: files(ds, "<p>plain</p>"), message: "Plain", origin: "user" });
    const draftVersion = (await versionsOf(page.id)).at(-1)!.versionId;
    await follow(projectId, false);
    return { page, draftVersion, projectId };
  }

  it("draws each version from what it recorded, not from the current setting", async () => {
    const { page, draftVersion } = await pageOnTheDraftThenBack();
    const versions = await versionsOf(page.id);
    expect(versions.map((v) => v.diffusion?.onDraft)).toEqual([true, true]);
    const markup = await (await fetch(`${server.artboardOrigin}${versionPreviewPath(page.id, draftVersion, "a.html")}`)).text();
    expect(markup).not.toMatch(/design-systems\/[^/]+\/diffusions\/\d+\/tokens\.css/);
    expect(markup).toContain("tokens.css");
  });

  it("logs each change of the setting in the project style history, and not a repeated one", async () => {
    const ds = await designSystem();
    const projectId = await project(ds);
    await follow(projectId, true);
    await follow(projectId, true);
    await follow(projectId, false);
    const log = ((await (await server.get(`/api/projects/${projectId}/project-style/versions`)).json()) as DesignMdVersion[]).filter((v) => v.setting);
    expect(log.map((v) => v.setting)).toEqual([
      { follows: "diffusion", designSystem: "Acme DS" },
      { follows: "draft", designSystem: "Acme DS" },
    ]);
  });

  it("logs the reset on a design system switch with the name of the new design system", async () => {
    const ds = await designSystem();
    const other = (await (await server.post("/api/design-systems", { title: "Other DS" })).json()) as DesignSystem;
    const projectId = await project(ds);
    await follow(projectId, true);
    await put(`/api/projects/${projectId}/design-system`, { designSystem: other.id });
    const log = ((await (await server.get(`/api/projects/${projectId}/project-style/versions`)).json()) as DesignMdVersion[]).filter((v) => v.setting);
    expect(log[0].setting).toEqual({ follows: "diffusion", designSystem: "Other DS" });
  });

  it("restores a version published on the draft after going back to the diffusion, and opens a thread listing what breaks", async () => {
    const { page, draftVersion } = await pageOnTheDraftThenBack();
    const restored = await server.post(`/api/pages/${page.id}/artboards/restore`, { file: "a.html", versionId: draftVersion, timeZone: "UTC" });
    expect(restored.status).toBe(201);
    const thread = (await threadsOf(page.id)).at(-1)!;
    expect(thread).toMatchObject({ title: "Restauration d'une version du brouillon", automatic: true });
    expect(thread.body).toContain("ui-card");
  });

  it("restores a whole page version published on the draft, instead of refusing the unknown tag", async () => {
    const { page, draftVersion } = await pageOnTheDraftThenBack();
    const restored = await server.post(`/api/pages/${page.id}/versions/${draftVersion}/restore`, { timeZone: "UTC" });
    expect(restored.status).toBe(201);
    expect((await threadsOf(page.id)).some((t) => t.title === "Restauration d'une version du brouillon")).toBe(true);
  });

  it("opens no thread when the restored version breaks nothing", async () => {
    const ds = await designSystem();
    const projectId = await project(ds);
    await follow(projectId, true);
    const page = (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: files(ds, "<ui-modal>x</ui-modal>") })).json()) as Page;
    await server.post(`/api/pages/${page.id}/versions`, { files: files(ds, "<p>plain</p>"), message: "Plain", origin: "user" });
    const draftVersion = (await versionsOf(page.id)).at(-1)!.versionId;
    await follow(projectId, false);
    expect((await server.post(`/api/pages/${page.id}/artboards/restore`, { file: "a.html", versionId: draftVersion, timeZone: "UTC" })).status).toBe(201);
    expect(await threadsOf(page.id)).toEqual([]);
  });
});

describe("the author of a setting change", () => {
  it("is the member who changed it", async () => {
    const instance = await new AccountsInstance().start();
    try {
      const ds = (await (await instance.admin.send("POST", "/api/design-systems", { title: "Acme DS" })).json()) as DesignSystem;
      const created = (await (await instance.admin.send("POST", "/api/projects", { title: "Acme", designSystem: ds.id })).json()) as { id: string };
      await instance.admin.send("PUT", `/api/projects/${created.id}/design-system`, { followsDraft: true });
      const log = (await instance.admin.json<DesignMdVersion[]>(`/api/projects/${created.id}/project-style/versions`)).filter((v) => v.setting);
      expect(log[0]).toMatchObject({ setting: { follows: "draft", designSystem: "Acme DS" }, person: { name: "Vincent Peraud" } });
    } finally {
      await instance.close();
    }
  });
});
