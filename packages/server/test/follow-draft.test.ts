import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type Page, type PageGaps, type ProjectDesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { AccountsInstance } from "./accounts-harness.js";

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n${extra}}\n`;
const componentFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const MODAL = componentFile(`<div><slot></slot></div>`);
const CARD = componentFile(`<section><slot></slot></section>`);
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("a project that follows the design system draft", () => {
  let server: TestServer;
  let token: string;
  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
  });
  afterEach(async () => {
    await server.stop();
  });

  const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const designSystem = async () =>
    (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss(), "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL } })).json()) as DesignSystem;
  /** A card component, a token and a changed DESIGN.md exist in the draft only (diffusion 1 has none). */
  const draftWork = async (ds: DesignSystem) => {
    const response = await server.post(`/api/pages/${ds.pageId}/versions`, {
      files: { "tokens.css": tokensCss("  --brand: #123456;\n"), "manifest.json": manifestOf(["components/modal.html", "components/card.html"]), "components/modal.html": MODAL, "components/card.html": CARD },
      message: "Add a card",
      origin: "thread",
    });
    expect(response.status).toBe(201);
  };
  const project = async (ds: DesignSystem) => ((await (await server.post("/api/projects", { title: "Acme", designSystem: ds.id })).json()) as { id: string }).id;
  const follow = (projectId: string, followsDraft: boolean) => put(`/api/projects/${projectId}/design-system`, { followsDraft });
  const detail = async (projectId: string) => (await (await server.get(`/api/projects/${projectId}/design-system`)).json()) as ProjectDesignSystem;
  const files = (ds: DesignSystem, body: string) => ({ "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(body) });
  const publishCard = (projectId: string, ds: DesignSystem) => server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: files(ds, `<ui-card>x</ui-card>`) });
  const agentGet = (path: string) => fetch(server.url + AGENT_API_PREFIX + path, { headers: { authorization: `Bearer ${token}` } });

  it("follows the latest diffusion by default, and reports the pending changes", async () => {
    const ds = await designSystem();
    const projectId = await project(ds);
    expect(await detail(projectId)).toMatchObject({ followsDraft: false, pendingChanges: 0 });
    await draftWork(ds);
    expect((await detail(projectId)).pendingChanges).toBeGreaterThan(0);
  });

  it("switches directly, and the project then sees the draft tokens", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    expect((await detail(projectId)).tokens.map((t) => t.name)).not.toContain("--brand");
    const response = await follow(projectId, true);
    expect(response.status).toBe(200);
    const after = (await response.json()) as ProjectDesignSystem;
    expect(after.followsDraft).toBe(true);
    expect(after.tokens.find((t) => t.name === "--brand")).toMatchObject({ status: "inherited", designSystemValue: "#123456", draftOnly: true });
    expect((await follow(projectId, false)).status).toBe(200);
    expect((await detail(projectId)).followsDraft).toBe(false);
  });

  it("accepts a component that exists only in the draft when following it, and refuses it otherwise", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    const refused = await publishCard(projectId, ds);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("<ui-card>");
    await follow(projectId, true);
    expect((await publishCard(projectId, ds)).status).toBe(201);
  });

  it("checks out the draft in .design-system/", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    const page = (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: files(ds, "<p>x</p>") })).json()) as Page;
    const checkout = async () => ((await (await agentGet(`/pages/${page.id}/files`)).json()) as AgentCheckout).project.designSystem!;
    expect(Object.keys((await checkout()).files)).not.toContain("components/card.html");
    await follow(projectId, true);
    const draft = await checkout();
    expect(Object.keys(draft.files)).toContain("components/card.html");
    expect(draft.files["tokens.css"]).toContain("--brand");
    expect(draft).toMatchObject({ diffusion: 1, draft: true });
  });

  it("computes the gaps against the draft", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    const page = (await (await server.post(`/api/projects/${projectId}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": mockup(`<p style="color:#123456">x</p>`) } })).json()) as Page;
    const gaps = async () => ((await (await server.get(`/api/pages/${page.id}/gaps`)).json()) as PageGaps).gaps;
    expect((await gaps()).map((g) => g.suggestion?.token)).not.toContain("--brand");
    await follow(projectId, true);
    expect((await gaps()).map((g) => g.suggestion?.token)).toContain("--brand");
  });

  it("refuses a project component named like a draft-only component, only when following the draft", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    const own = { "manifest.json": manifestOf(["components/card.html"], ds.id), "components/card.html": CARD };
    expect((await server.post(`/api/projects/${projectId}/pages`, { title: "Own", files: own })).status).toBe(201);
    const second = await project(ds);
    await follow(second, true);
    const refused = await server.post(`/api/projects/${second}/pages`, { title: "Own", files: own });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("already exists");
  });

  it("flags a version published on the draft, with the diffusion it follows", async () => {
    const ds = await designSystem();
    await draftWork(ds);
    const projectId = await project(ds);
    const created = (await (await publishAfterFollow(projectId, ds)).json()) as Page;
    const versions = (await (await server.get(`/api/pages/${created.id}/artboard-versions?file=a.html`)).json()) as { diffusion?: { number: number; onDraft?: boolean } }[];
    expect(versions[0].diffusion).toMatchObject({ number: 1, onDraft: true });
    async function publishAfterFollow(id: string, system: DesignSystem) {
      await follow(id, true);
      return publishCard(id, system);
    }
  });

  it("clears the setting when the project switches to another design system", async () => {
    const ds = await designSystem();
    const other = await designSystem();
    const projectId = await project(ds);
    await follow(projectId, true);
    await put(`/api/projects/${projectId}/design-system`, { designSystem: other.id });
    expect((await detail(projectId)).followsDraft).toBe(false);
  });

  it("refuses the setting to a member with Read rights", async () => {
    const instance = await new AccountsInstance().start();
    try {
      const { ariane, thomas, people } = instance;
      const created = await instance.createProject(ariane);
      await ariane.send("PUT", `/api/projects/${created.id}/members/${people.thomas.id}`, { level: "read" });
      expect((await thomas.send("PUT", `/api/projects/${created.id}/design-system`, { followsDraft: true })).status).toBe(403);
    } finally {
      await instance.close();
    }
  });
});
