import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type DesignSystemDetail, type Page, type Project, type SendRequestResponse, type Thread, type WorkItem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div class="modal"><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });

describe("a diffusion closes requests and reopens their threads", () => {
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
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
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
  const diffuse = () => server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  const overview = async () => (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  };

  it("closes the diffused request, out of the lists and counts, and leaves a request with no change", async () => {
    const answered = await ask();
    const waiting = await ask();
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: answered }]);

    expect((await diffuse()).status).toBe(201);

    const closed = await threadOf(ds.pageId, answered);
    expect(closed).toMatchObject({ status: "resolved", request: { state: "diffused" } });
    expect((await threadOf(ds.pageId, waiting)).request!.state).toBe("in_progress");
    expect((await overview()).requests.map((r) => r.threadId)).toEqual([waiting]);
  });

  it("reopens the thread of the user's comment, signed Redline, with what is available", async () => {
    const origin = await comment();
    await server.post(`/api/threads/${origin.id}/resolve`, {});
    const request = await ask(origin.id);
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);

    await diffuse();

    const reopened = await threadOf(planning.id, origin.id);
    expect(reopened.status).toBe("open");
    expect(reopened.replies).toHaveLength(1);
    expect(reopened.replies[0]).toMatchObject({ author: "redline" });
    expect(reopened.replies[0]!.body).toContain("Taille 720 px");
    expect(reopened.replies[0]!.body).toContain("ui-modal");
    expect(reopened.replies[0]!.body).toContain("diffusion 2");
  });

  it("opens a thread signed Redline on the instance when the request had no origin thread", async () => {
    const request = await ask();
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);

    await diffuse();

    const [opened] = await threadsOf(planning.id);
    expect(opened).toMatchObject({ automatic: true, status: "open", artboard: "page.html", selector: "#edit" });
    expect(opened!.body).toContain("Taille 720 px");
  });

  it("returns to every origin of a request merged from several pages", async () => {
    const other = (await (await server.post(`/api/projects/${app.id}/pages`, {
      title: "Inscription",
      files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` },
    })).json()) as Page;
    const first = await ask();
    const second = ((await (await agent(`/pages/${other.id}/requests`, { component: "ui-modal", missing: "720", artboard: "page.html", selector: "#edit" })).json()) as SendRequestResponse).threadId;
    await agent(`/requests/${second}/merge`, { into: first });
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: second }]);

    await diffuse();

    expect(await threadOf(ds.pageId, first)).toMatchObject({ status: "resolved", request: { state: "diffused" } });
    expect(await threadsOf(planning.id)).toHaveLength(1);
    expect(await threadsOf(other.id)).toHaveLength(1);
  });

  it("sends the Redline message to the project's agent", async () => {
    const origin = await comment();
    const request = await ask(origin.id);
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);

    await diffuse();

    const connected = await server.connectAgent({ machine: "MacBook", folder: "/work/app", projectId: app.id });
    await connected.hello;
    const received = () => connected.messages.flatMap((m) => (m.type === "work" ? [m.item] : [])) as WorkItem[];
    await until(() => received().some((item) => item.threads.some((t) => t.threadId === origin.id)));
    const sent = received().find((item) => item.threads.some((t) => t.threadId === origin.id))!;
    expect(sent.message).toContain("Reply from Redline");
    expect(sent.message).toContain("Taille 720 px");
  });

  it("closes the request of an archived page without a return thread, and opens it when the page is unarchived", async () => {
    const origin = await comment();
    const request = await ask(origin.id);
    await publish([{ component: "modal", label: "Taille 720 px", kind: "added", threadId: request }]);
    await server.post(`/api/pages/${planning.id}/archive`, {});

    await diffuse();

    expect(await threadOf(ds.pageId, request)).toMatchObject({ status: "resolved", request: { state: "diffused" } });
    expect((await threadOf(ds.pageId, request)).replies.map((r) => r.body).join("\n")).toContain("page archivée");
    expect((await threadOf(planning.id, origin.id)).replies).toEqual([]);

    await server.post(`/api/pages/${planning.id}/unarchive`, {});

    const returned = await threadOf(planning.id, origin.id);
    expect(returned.replies).toHaveLength(1);
    expect(returned.replies[0]).toMatchObject({ author: "redline" });
    expect(returned.replies[0]!.body).toContain("Taille 720 px");
    // Unarchiving again does not return twice.
    await server.post(`/api/pages/${planning.id}/archive`, {});
    await server.post(`/api/pages/${planning.id}/unarchive`, {});
    expect((await threadOf(planning.id, origin.id)).replies).toHaveLength(1);
  });
});
