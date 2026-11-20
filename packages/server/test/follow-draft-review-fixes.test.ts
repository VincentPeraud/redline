import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type BrokenPagesAnswer, type ChangeRecord, type DesignSystem, type DesignSystemSwitchPreview, type Page, type RollbackImpact, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { AccountsInstance } from "./accounts-harness.js";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const PLAIN = componentFile(`<div><slot></slot></div>`);
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: `Board ${i + 1}`, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
const componentsOf = (...names: string[]) => Object.fromEntries(names.map((name) => [`components/${name}.html`, PLAIN]));
const dsFiles = (...names: string[]) => ({ "tokens.css": tokensCss, "manifest.json": manifestOf(names.map((name) => `components/${name}.html`)), ...componentsOf(...names) });

describe("review fixes of the follow-the-draft lot", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    await server.stop();
  });

  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const designSystem = async (...names: string[]) => (await (await server.post("/api/design-systems", { title: "Acme DS", files: dsFiles(...names) })).json()) as DesignSystem;
  const publishDs = (ds: DesignSystem, ...names: string[]) => server.post(`/api/pages/${ds.pageId}/versions`, { files: dsFiles(...names), message: "Edit", origin: "thread", confirmRemovals: true });
  const projectOn = async (ds: DesignSystem, title = "App") => ((await (await server.post("/api/projects", { title, designSystem: ds.id })).json()) as { id: string }).id;
  const follow = (projectId: string, followsDraft: boolean) => put(`/api/projects/${projectId}/design-system`, { followsDraft, confirm: true });
  const pageOf = async (ds: DesignSystem, projectId: string, body: string) =>
    (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(body) } })).json()) as Page;
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

  async function listenToEvents() {
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
    return {
      updates: () =>
        frames
          .join("")
          .split("\n\n")
          .filter((frame) => frame.includes("design-system-updated"))
          .map((frame) => JSON.parse(frame.slice(frame.indexOf("{"))) as { designSystemId?: string; projectId?: string; pageIds: string[] }),
      stop: () => abort.abort(),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it("tells the open pages and the design system screens when the setting is turned on or off", async () => {
    const ds = await designSystem("modal");
    const projectId = await projectOn(ds);
    const page = await pageOf(ds, projectId, "<p>x</p>");
    const events = await listenToEvents();
    await follow(projectId, true);
    await settle();
    await follow(projectId, false);
    await settle();
    events.stop();
    const own = events.updates().filter((event) => event.projectId === projectId);
    expect(own).toHaveLength(2);
    expect(own[0]).toMatchObject({ designSystemId: ds.id, pageIds: [page.id] });
  });

  it("opens the switch dialog for a project on the draft even when no component changes", async () => {
    const ds = await designSystem("modal");
    const other = await designSystem("modal");
    const projectId = await projectOn(ds);
    expect(((await (await server.get(`/api/projects/${projectId}/design-system/switch?to=${other.id}`)).json()) as DesignSystemSwitchPreview).followsDraft).toBe(false);
    await follow(projectId, true);
    const preview = (await (await server.get(`/api/projects/${projectId}/design-system/switch?to=${other.id}`)).json()) as DesignSystemSwitchPreview;
    expect(preview).toMatchObject({ components: [], followsDraft: true });
  });

  describe("restoring a version published on the draft", () => {
    /** A page written with the draft-only ui-card, then the project goes back to the diffusion. */
    async function pageThenBack() {
      const ds = await designSystem("modal");
      await publishDs(ds, "modal", "card");
      const projectId = await projectOn(ds);
      await follow(projectId, true);
      const page = await pageOf(ds, projectId, "<ui-card>x</ui-card>");
      await server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup("<p>plain</p>") }, message: "Plain", origin: "user" });
      const versions = (await (await server.get(`/api/pages/${page.id}/artboard-versions?file=a.html`)).json()) as { versionId: string }[];
      await follow(projectId, false);
      return { ds, page, projectId, draftVersion: versions.at(-1)!.versionId };
    }

    it("names what breaks with the texts of the shared computation, tokens included", async () => {
      const { page, draftVersion } = await pageThenBack();
      expect((await server.post(`/api/pages/${page.id}/versions/${draftVersion}/restore`, { timeZone: "UTC" })).status).toBe(201);
      const thread = (await threadsOf(page.id)).find((t) => t.title === "Restauration d'une version du brouillon")!;
      expect(thread.body).toContain("le composant ui-card");
    });

    it("still refuses an element that exists in neither the draft nor the diffusion", async () => {
      const { ds, page, draftVersion } = await pageThenBack();
      await publishDs(ds, "modal");
      const refused = await server.post(`/api/pages/${page.id}/versions/${draftVersion}/restore`, { timeZone: "UTC" });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toContain("<ui-card>");
    });
  });

  it("does not count the pages of a project on the draft in a rollback", async () => {
    const ds = await designSystem("modal");
    await publishDs(ds, "modal", "card");
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    const following = await projectOn(ds, "Following");
    await follow(following, true);
    await pageOf(ds, following, "<ui-card>x</ui-card>");
    expect(((await (await server.get(`/api/design-systems/${ds.id}/diffusions/1/rollback-impact`)).json()) as RollbackImpact).components).toEqual([]);
    expect((await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {})).status).toBe(201);
  });

  it("opens the removal threads when an artboard restore takes a component out of the draft", async () => {
    const ds = await designSystem("modal");
    const firstVersion = ((await (await server.get(`/api/pages/${ds.pageId}/versions`)).json()) as { id: string }[]).at(-1)!.id;
    await publishDs(ds, "modal", "card");
    const projectId = await projectOn(ds);
    await follow(projectId, true);
    const page = await pageOf(ds, projectId, "<ui-card>x</ui-card>");
    const restored = await server.post(`/api/pages/${ds.pageId}/artboards/restore`, { file: "components/card.html", versionId: firstVersion, timeZone: "UTC" });
    expect(restored.status).toBe(201);
    expect((await threadsOf(page.id)).filter((t) => t.title === "Retrait dans le design system")).toHaveLength(1);
  });

  it("replies in a removal thread only for the same element, never for one whose name starts like it", async () => {
    const ds = await designSystem("button-group");
    await publishDs(ds, "button");
    const projectId = await projectOn(ds);
    const page = await pageOf(ds, projectId, "<ui-button-group>x</ui-button-group>");
    expect((await follow(projectId, true)).status).toBe(200);
    expect((await threadsOf(page.id)).filter((t) => t.title === "Retrait dans le design system")).toHaveLength(1);
    await server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup("<ui-button>x</ui-button>") }, message: "Use button", origin: "user" });
    expect((await follow(projectId, false)).status).toBe(200);
    const threads = await threadsOf(page.id);
    expect(threads.find((t) => t.title === "Retrait dans le design system")!.replies).toEqual([]);
    expect(threads.filter((t) => t.title === "Retour à la dernière diffusion")).toHaveLength(1);
  });
});

describe("what a member may learn about projects she cannot read", () => {
  let instance: AccountsInstance;
  beforeEach(async () => {
    instance = await new AccountsInstance().start();
  });
  afterEach(async () => {
    await instance.close();
  });

  /** Ariane edits the design system and has the project "Mine"; Marc has "Secret", which she cannot read. Both follow the draft. */
  async function setup() {
    const { admin, ariane, marc, people } = instance;
    const ds = (await (await admin.send("POST", "/api/design-systems", { title: "Acme DS", files: dsFiles("modal") })).json()) as DesignSystem;
    await admin.send("PUT", `/api/projects/${ds.id}/members/${people.ariane.id}`, { level: "write" });
    const mine = await instance.createProject(ariane, { title: "Mine", designSystem: ds.id });
    const secret = await instance.createProject(marc, { title: "Secret", designSystem: ds.id, visibility: "private" });
    const files = (id: string) => ({ "manifest.json": manifestOf(["a.html"], id), "a.html": mockup("<ui-modal>x</ui-modal>") });
    await ariane.send("POST", `/api/projects/${mine.id}/pages`, { title: "Flow", files: files(ds.id) });
    await marc.send("POST", `/api/projects/${secret.id}/pages`, { title: "Hidden", files: files(ds.id) });
    for (const [who, project] of [[ariane, mine], [marc, secret]] as const) expect((await who.send("PUT", `/api/projects/${project.id}/design-system`, { followsDraft: true })).status).toBe(200);
    return { ds, mine, secret };
  }

  it("lists in draft-users only the pages of projects the viewer can read", async () => {
    const { ds } = await setup();
    const token = ((await instance.ariane.json<AgentTokenResponse>("/api/agent-token")).token);
    const checkout = (await (await fetch(`${instance.server.url}${AGENT_API_PREFIX}/pages/${ds.pageId}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout;
    const published = await fetch(`${instance.server.url}${AGENT_API_PREFIX}/pages/${ds.pageId}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ files: checkout.files, message: "Edit modal", origin: "thread", baseVersionId: checkout.versionId, changes: [{ component: "modal", label: "Taille", kind: "added" }] }),
    });
    expect(published.status).toBe(201);
    const [change] = (await instance.admin.json<ChangeRecord[]>(`/api/design-systems/${ds.id}/changes`));
    const asAdmin = await instance.admin.json<{ pages: { projectTitle: string }[] }>(`/api/changes/${change.id}/draft-users`);
    expect(asAdmin.pages.map((p) => p.projectTitle).sort()).toEqual(["Mine", "Secret"]);
    const asAriane = await instance.ariane.json<{ pages: { projectTitle: string }[] }>(`/api/changes/${change.id}/draft-users`);
    expect(asAriane.pages.map((p) => p.projectTitle)).toEqual(["Mine"]);
  });

  it("names only readable projects in the turn-off answer and counts the others", async () => {
    const { mine } = await setup();
    const answer = (await (await instance.ariane.send("PUT", `/api/projects/${mine.id}/design-system`, { followsDraft: false })).json()) as BrokenPagesAnswer;
    expect(answer.otherProjects).toEqual([]);
    expect(answer.hiddenProjects).toBe(1);
  });

  it("lists in the checkout of a design system session only the followers the person can read", async () => {
    const { ds } = await setup();
    const token = (await instance.ariane.json<AgentTokenResponse>("/api/agent-token")).token;
    const checkout = (await (await fetch(`${instance.server.url}${AGENT_API_PREFIX}/pages/${ds.pageId}/files`, { headers: { authorization: `Bearer ${token}` } })).json()) as AgentCheckout;
    expect(checkout.project.editsDesignSystem?.followedBy.map((p) => p.title)).toEqual(["Mine"]);
  });
});
