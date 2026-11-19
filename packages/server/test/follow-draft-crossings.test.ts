import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type DesignSystemDetail, type DesignSystemSwitchPreview, type Page, type ProjectDesignSystem, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const componentFile = (name: string) => `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component><div><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("crossings of the follow-the-draft setting with existing rules", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let projectId: string;
  let page: Page;
  let version = 0;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = await designSystem("Lumora");
    projectId = ((await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string }).id;
    page = (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Planning", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(`<ui-modal id="edit"></ui-modal>`) } })).json()) as Page;
    version = 0;
  });
  afterEach(async () => {
    await server.stop();
  });

  const designSystem = async (title: string) =>
    (await (await server.post("/api/design-systems", { title, files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": componentFile("modal") } })).json()) as DesignSystem;
  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const follow = (followsDraft: boolean) => put(`/api/projects/${projectId}/design-system`, { followsDraft, ...(followsDraft ? {} : { confirm: true }) });
  const detail = async () => (await (await server.get(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem;
  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const ask = async () =>
    ((await (await agent(`/pages/${page.id}/requests`, { component: "ui-modal", missing: "A 720 px size", artboard: "a.html", selector: "#edit" })).json()) as SendRequestResponse).threadId;
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
  const threadOf = async (id: string) => (await threadsOf(ds.pageId)).find((t) => t.id === id)!;
  const publishInDesignSystem = async (changes: object[]) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${ds.pageId}/versions`, {
      files: { ...checkout.files, "components/modal.html": componentFile(`modal${++version}`) },
      message: "Wide modal",
      origin: "thread",
      baseVersionId: checkout.versionId,
      changes,
    });
  };
  const overview = async () => (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
  const publishPage = async (extra: object) => {
    const checkout = (await (await agent(`/pages/${page.id}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${page.id}/versions`, { files: { ...checkout.files, "a.html": mockup(`<p>${++version}</p>`) }, message: "Edit", origin: "terminal", baseVersionId: checkout.versionId, ...extra });
  };

  describe("request closing", () => {
    it("closes a request as soon as its change is published in the draft when the requester follows it", async () => {
      await follow(true);
      const request = await ask();
      expect((await publishInDesignSystem([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }])).status).toBe(201);
      expect(await threadOf(request)).toMatchObject({ status: "resolved", request: { state: "done_in_draft" } });
      expect((await overview()).requests).toEqual([]);
    });

    it("leaves the request open when the requester stays on the latest diffusion", async () => {
      const request = await ask();
      await publishInDesignSystem([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);
      expect(await threadOf(request)).toMatchObject({ status: "open", request: { state: "done_in_draft" } });
      expect((await overview()).requests.map((r) => r.threadId)).toEqual([request]);
    });

    it("keeps it closed when the project goes back, moves it to diffused at the diffusion and does not wake a project on the draft", async () => {
      await follow(true);
      const request = await ask();
      await publishInDesignSystem([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);
      await follow(false);
      expect((await threadOf(request)).status).toBe("resolved");
      expect((await overview()).requests).toEqual([]);
      expect((await server.post(`/api/design-systems/${ds.id}/diffusions`, {})).status).toBe(201);
      expect(await threadOf(request)).toMatchObject({ status: "resolved", request: { state: "diffused" } });
    });

    it("does not tell a project on the draft at the diffusion, and tells one that went back to the diffusion", async () => {
      await follow(true);
      const request = await ask();
      await publishInDesignSystem([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect(await threadsOf(page.id)).toEqual([]);

      const second = await ask();
      await follow(false);
      await publishInDesignSystem([{ component: "modal", label: "Autre taille", kind: "added", threadId: second }]);
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await threadsOf(page.id)).map((t) => t.title)).toEqual(["Disponible dans le design system"]);
    });
  });

  describe("switching the design system", () => {
    it("compares against the target's current diffusion and says the project will follow it", async () => {
      await server.post(`/api/pages/${ds.pageId}/versions`, {
        files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "components/card.html"]), "components/modal.html": componentFile("modal"), "components/card.html": componentFile("card") },
        message: "Add a card",
        origin: "thread",
      });
      await follow(true);
      const draftPage = await server.post(`/api/projects/${projectId}/pages`, { title: "Cards", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(`<ui-card>x</ui-card>`) } });
      expect(draftPage.status).toBe(201);
      const other = await designSystem("Brightco");
      await server.post(`/api/pages/${other.pageId}/versions`, {
        files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "components/card.html"]), "components/modal.html": componentFile("modal"), "components/card.html": componentFile("card") },
        message: "Draft card only",
        origin: "thread",
      });
      const preview = (await (await server.get(`/api/projects/${projectId}/design-system/switch?to=${other.id}`)).json()) as DesignSystemSwitchPreview;
      expect(preview.followsDraft).toBe(true);
      expect(preview.components.find((c) => c.name === "card")).toMatchObject({ match: "absent" });
      expect(preview.components.find((c) => c.name === "modal")).toMatchObject({ match: "same" });
    });

    it("reports a project on the latest diffusion as such", async () => {
      const other = await designSystem("Brightco");
      const preview = (await (await server.get(`/api/projects/${projectId}/design-system/switch?to=${other.id}`)).json()) as DesignSystemSwitchPreview;
      expect(preview.followsDraft).toBe(false);
    });

    it("puts the setting back on the latest diffusion", async () => {
      await follow(true);
      const other = await designSystem("Brightco");
      expect((await put(`/api/projects/${projectId}/design-system`, { designSystem: other.id })).status).toBe(200);
      expect((await detail()).followsDraft).toBe(false);
    });
  });

  describe("undo and rollback", () => {
    it("leave a project on the draft on the draft", async () => {
      await follow(true);
      await server.post(`/api/pages/${ds.pageId}/versions`, {
        files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html", "components/card.html"]), "components/modal.html": componentFile("modal"), "components/card.html": componentFile("card") },
        message: "Add a card",
        origin: "thread",
      });
      await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
      expect((await server.post(`/api/design-systems/${ds.id}/diffusions/1/rollback`, {})).status).toBe(201);
      expect((await detail()).followsDraft).toBe(true);
      const checkout = (await (await agent(`/pages/${page.id}/files`)).json()) as AgentCheckout;
      expect(Object.keys(checkout.project.designSystem!.files)).toContain("components/card.html");
      expect(checkout.project.designSystem).toMatchObject({ draft: true });
      expect((await server.post(`/api/design-systems/${ds.id}/diffusions/undo`, {})).status).toBe(200);
      expect((await detail()).followsDraft).toBe(true);
    });
  });

  describe("publishing after the setting changed", () => {
    it("refuses a publish checked out under another setting and asks to check out again", async () => {
      const refused = await publishPage({ followsDraft: true });
      expect(refused.status).toBe(409);
      const message = ((await refused.json()) as { error: string }).error;
      expect(message).toContain("latest diffusion");
      expect(message).toContain("Check the page out again");
      await follow(true);
      const again = await publishPage({ followsDraft: false });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain("draft");
    });

    it("accepts a publish made under the current setting, or one that does not say", async () => {
      expect((await publishPage({ followsDraft: false })).status).toBe(201);
      await follow(true);
      expect((await publishPage({ followsDraft: true })).status).toBe(201);
      expect((await publishPage({})).status).toBe(201);
    });
  });

  it("keeps the last write when two members change the setting", async () => {
    await follow(true);
    await follow(false);
    expect((await detail()).followsDraft).toBe(false);
  });
});
