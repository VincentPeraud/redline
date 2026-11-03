import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type ChangeRecord, type DesignSystem, type DiffusionReview, type Page, type Project, type SendRequestResponse, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div class="modal"><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });

describe("refusing a change or a request", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let app: Project;
  let planning: Page;
  let version = 0;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", {
      title: "Lumora",
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL },
    })).json()) as DesignSystem;
    app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    planning = (await (await server.post(`/api/projects/${app.id}/pages`, {
      title: "Planning",
      files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` },
    })).json()) as Page;
    version = 0;
  });
  afterEach(async () => {
    await server.stop();
  });

  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const ask = async (threadId?: string) =>
    ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "A 720 px size", artboard: "page.html", selector: "#edit", ...(threadId ? { threadId } : {}) })).json()) as SendRequestResponse).threadId;
  const threadOf = async (pageId: string, id: string) => ((await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[]).find((t) => t.id === id)!;
  const comment = async () =>
    (await (await server.post(`/api/pages/${planning.id}/threads`, { artboard: "page.html", selector: "#edit", xPct: 10, yPct: 10, body: "Need a bigger modal" })).json()) as Thread;
  const publish = async (changes: object[]) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    return agent(`/pages/${ds.pageId}/versions`, {
      files: { ...checkout.files, "components/modal.html": MODAL.replace("modal", `modal v${++version}`) },
      message: "Wide modal",
      origin: "thread",
      baseVersionId: checkout.versionId,
      changes,
    });
  };
  const changes = async () => (await (await server.get(`/api/design-systems/${ds.id}/changes`)).json()) as ChangeRecord[];
  const review = async () => (await (await server.get(`/api/design-systems/${ds.id}/review`)).json()) as DiffusionReview;
  const diffuse = () => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const overviewRequests = async () => ((await (await server.get(`/api/design-systems/${ds.id}`)).json()) as { requests: unknown[] }).requests;
  const size = (threadId: string) => ({ component: "modal", label: "Taille 720 px", kind: "added", threadId });
  const cross = (threadId: string) => ({ component: "modal", label: "Croix ronde", kind: "modified", threadId });

  it("refuses one change: posts the answer, shows it undoing, tells the origin thread and blocks Diffuser", async () => {
    const origin = await comment();
    const request = await ask(origin.id);
    await publish([size(request), cross(request)]);
    const [first] = await changes();

    expect((await server.post(`/api/changes/${first!.id}/refuse`, {})).status).toBe(200);

    expect((await changes()).map((c) => [c.label, c.state])).toEqual([["Taille 720 px", "refused"], ["Croix ronde", "pending"]]);
    const thread = await threadOf(ds.pageId, request);
    expect(thread.request!.state).toBe("done_in_draft");
    expect(thread.replies.at(-1)).toMatchObject({ author: "user" });
    expect(thread.replies.at(-1)!.body).toContain("Taille 720 px");
    const told = await threadOf(planning.id, origin.id);
    expect(told.replies.at(-1)).toMatchObject({ author: "redline" });
    expect(told.replies.at(-1)!.body).toContain("Taille 720 px");
    const lines = (await review()).components[0]!.changes;
    expect(lines.map((l) => [l.label, l.undoing, l.refusable])).toEqual([["Taille 720 px", true, false], ["Croix ronde", false, true]]);
    expect((await review()).undoing).toBe(1);
    expect((await diffuse()).status).toBe(409);
  });

  it("keeps every message for an archived origin, a refusal then a diffusion, and delivers them all on unarchive", async () => {
    const origin = await comment();
    const request = await ask(origin.id);
    await publish([size(request), cross(request)]);
    await server.post(`/api/pages/${planning.id}/archive`, {});
    await server.post(`/api/changes/${(await changes())[0]!.id}/refuse`, {});
    await publish([{ component: "modal", label: "Taille retirée", kind: "modified", threadId: request }]);
    expect((await diffuse()).status).toBe(201);

    await server.post(`/api/pages/${planning.id}/unarchive`, {});

    const bodies = (await threadOf(planning.id, origin.id)).replies.map((r) => r.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain("Taille 720 px");
    expect(bodies[1]).toContain("Croix ronde");
  });

  it("creates a thread on the instance when the request had no origin thread", async () => {
    const request = await ask();
    await publish([size(request)]);
    await server.post(`/api/changes/${(await changes())[0]!.id}/refuse`, {});
    const threads = (await (await server.get(`/api/pages/${planning.id}/threads`)).json()) as Thread[];
    expect(threads).toHaveLength(1);
    expect(threads[0]!.body).toContain("Taille 720 px");
  });

  it("lets Diffuser through again once the session published the undo, and the change disappears", async () => {
    const request = await ask();
    await publish([size(request), cross(request)]);
    await server.post(`/api/changes/${(await changes())[0]!.id}/refuse`, {});

    expect((await publish([{ component: "modal", label: "Taille retirée", kind: "modified", threadId: request }])).status).toBe(201);

    expect((await changes()).map((c) => [c.label, c.state])).toEqual([["Croix ronde", "pending"]]);
    expect((await diffuse()).status).toBe(201);
  });

  it("refuses the whole request from its card: every change and the request", async () => {
    const request = await ask();
    await publish([size(request), cross(request)]);

    expect((await server.post(`/api/threads/${request}/refuse`, {})).status).toBe(200);

    expect((await changes()).map((c) => c.state)).toEqual(["refused", "refused"]);
    expect((await threadOf(ds.pageId, request)).request!.state).toBe("refused");
    expect((await server.post(`/api/threads/${request}/refuse`, {})).status).toBe(409);
    expect(await overviewRequests()).toHaveLength(0);
  });

  it("refuses a request that has no change yet, and a late publish for it is a change to undo", async () => {
    const request = await ask();
    expect((await server.post(`/api/threads/${request}/refuse`, {})).status).toBe(200);
    expect(await changes()).toEqual([]);

    await publish([size(request)]);

    const [late] = await changes();
    expect(late).toMatchObject({ label: "Taille 720 px", state: "refused" });
    expect((await threadOf(ds.pageId, request)).request!.state).toBe("refused");
    expect((await diffuse()).status).toBe(409);
  });

  it("turns a request refused when its last change is refused, and keeps it open while another stays", async () => {
    const request = await ask();
    await publish([size(request), cross(request)]);
    const [first, second] = await changes();
    await server.post(`/api/changes/${first!.id}/refuse`, {});
    expect((await threadOf(ds.pageId, request)).request!.state).toBe("done_in_draft");
    await server.post(`/api/changes/${second!.id}/refuse`, {});
    expect((await threadOf(ds.pageId, request)).request!.state).toBe("refused");
  });

  it("recalls what was refused in the diffusion return of a partly refused request", async () => {
    const origin = await comment();
    const request = await ask(origin.id);
    await publish([size(request), cross(request)]);
    await server.post(`/api/changes/${(await changes())[0]!.id}/refuse`, {});
    await publish([{ component: "modal", label: "Taille retirée", kind: "modified", threadId: request }]);

    expect((await diffuse()).status).toBe(201);

    const reply = (await threadOf(planning.id, origin.id)).replies.at(-1)!;
    expect(reply.body).toContain("Croix ronde");
    expect(reply.body).toContain("Refusé : Taille 720 px");
  });

  it("refuses only a pending change born of a request", async () => {
    await publish([{ component: "modal", label: "Pied de page", kind: "added" }]);
    const [direct] = await changes();
    expect((await server.post(`/api/changes/${direct!.id}/refuse`, {})).status).toBe(409);
    expect((await server.post(`/api/changes/unknown/refuse`, {})).status).toBe(404);
  });
});
