import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type ChangeRecord, type DesignSystem, type Page, type Project, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const component = (template: string) => `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component>${template}</template></body></html>`;
const PLAIN = component(`<div><slot></slot></div>`);
const WITH_TITLE = component(`<div><h2><slot name="title"></slot></h2><slot></slot></div>`);
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });
const RETRAIT = "Retrait dans le design system";

describe("removals and refusals for projects on the draft", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let app: Project;
  let planning: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", {
      title: "Lumora",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": PLAIN },
    })).json()) as DesignSystem;
    app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    planning = (await (await server.post(`/api/projects/${app.id}/pages`, {
      title: "Planning",
      files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` },
    })).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const follow = (projectId: string, followsDraft: boolean) =>
    fetch(`${server.url}/api/projects/${projectId}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ followsDraft, confirm: true }) });
  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
  const retraits = async (pageId: string) => (await threadsOf(pageId)).filter((t) => t.title === RETRAIT);
  const publishDs = async (modal: string, changes?: object[]) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${ds.pageId}/versions`, {
      files: { ...checkout.files, "components/modal.html": modal },
      message: "Edit",
      origin: "thread",
      baseVersionId: checkout.versionId,
      confirmRemovals: true,
      ...(changes ? { changes } : {}),
    });
  };
  const diffuse = () => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const removeModalFromDraft = () =>
    server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss, "manifest.json": manifestOf([]) }, message: "Remove modal", origin: "thread", confirmRemovals: true });

  it("opens the removal thread at the publish for a project on the draft, and not again at the diffusion", async () => {
    await follow(app.id, true);

    expect((await removeModalFromDraft()).status).toBe(201);

    const threads = await retraits(planning.id);
    expect(threads).toHaveLength(1);
    expect(threads[0].body).toContain("ui-modal");
    expect((await diffuse()).status).toBe(201);
    expect(await retraits(planning.id)).toHaveLength(1);
  });

  it("gives a project back on the diffusion in between its thread at the diffusion, as today", async () => {
    await follow(app.id, true);
    await removeModalFromDraft();
    await follow(app.id, false);

    expect((await diffuse()).status).toBe(201);

    expect(await retraits(planning.id)).toHaveLength(2);
  });

  it("opens nothing at the publish for a project on the diffusion", async () => {
    await removeModalFromDraft();

    expect(await retraits(planning.id)).toEqual([]);
  });

  it("leaves the thread open when the removal is undone in the draft before the diffusion", async () => {
    await follow(app.id, true);
    await removeModalFromDraft();
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    await agent(`/pages/${ds.pageId}/versions`, { files: { ...checkout.files, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": PLAIN }, message: "Back", origin: "thread", baseVersionId: checkout.versionId });

    const threads = await retraits(planning.id);
    expect(threads).toHaveLength(1);
    expect(threads[0].resolved).toBeFalsy();
  });

  it("treats a refused change then undone in the draft as a removal: thread on the page and the origin told with the answer", async () => {
    await follow(app.id, true);
    const origin = (await (await server.post(`/api/pages/${planning.id}/threads`, { artboard: "page.html", selector: "#edit", xPct: 10, yPct: 10, body: "Need a title" })).json()) as Thread;
    const request = ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "A title", artboard: "page.html", selector: "#edit", threadId: origin.id })).json()) as SendRequestResponse).threadId;
    await publishDs(WITH_TITLE, [{ component: "modal", label: "Titre", kind: "added", threadId: request }]);
    await server.post(`/api/pages/${planning.id}/versions`, {
      files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": `<!doctype html><body><ui-modal><span slot="title">T</span></ui-modal></body>` },
      message: "Use the title",
      origin: "thread",
    });
    const [change] = (await (await server.get(`/api/design-systems/${ds.id}/changes`)).json()) as ChangeRecord[];
    await server.post(`/api/changes/${change!.id}/refuse`, { answer: "Pas de titre dans les modales" });
    expect(await retraits(planning.id)).toHaveLength(0);

    await publishDs(PLAIN, [{ component: "modal", label: "Titre retiré", kind: "modified", threadId: request }]);

    const threads = await retraits(planning.id);
    expect(threads).toHaveLength(1);
    expect(threads[0].body).toContain("title");
    const told = (await threadsOf(planning.id)).find((t) => t.id === origin.id)!;
    expect(told.resolved).toBeFalsy();
    expect(told.replies.at(-1)!.body).toContain("Pas de titre dans les modales");
    expect(told.replies.at(-1)!.body).toContain("retiré du brouillon");
  });

  it("names the pages of projects on the draft that use a change", async () => {
    await follow(app.id, true);
    const request = ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "A title", artboard: "page.html", selector: "#edit" })).json()) as SendRequestResponse).threadId;
    await publishDs(WITH_TITLE, [{ component: "modal", label: "Titre", kind: "added", threadId: request }]);
    const [change] = (await (await server.get(`/api/design-systems/${ds.id}/changes`)).json()) as ChangeRecord[];

    expect(await (await server.get(`/api/changes/${change!.id}/draft-users`)).json()).toEqual({ pages: [{ pageId: planning.id, projectTitle: "App", pageTitle: "Planning" }] });
    await follow(app.id, false);
    expect(await (await server.get(`/api/changes/${change!.id}/draft-users`)).json()).toEqual({ pages: [] });
  });
});
