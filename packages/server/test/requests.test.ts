import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentTokenResponse, type DesignSystem, type DesignSystemDetail, type Page, type Project, type SendRequestResponse, type Thread, type WorkItem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component><div class="modal"><slot></slot></div></template></body></html>`;
const sizeTweak = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: designSystem ? [] : [sizeTweak] });

describe("requests to the design system", () => {
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
      files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL },
    })).json()) as DesignSystem;
    app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    planning = (await (await server.post(`/api/projects/${app.id}/pages`, {
      title: "Planning",
      files: { "manifest.json": manifestOf(["planning.html"], ds.id), "planning.html": `<!doctype html><body><ui-modal id="edit"></ui-modal></body>` },
    })).json()) as Page;
  });
  afterEach(async () => {
    await server.stop();
  });

  const send = (body: object, pageId = planning.id) =>
    fetch(`${server.url}${AGENT_API_PREFIX}/pages/${pageId}/requests`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ component: "ui-modal", missing: "A 720 px size", artboard: "planning.html", selector: "#edit", ...body }),
    });
  const threadsOf = async (pageId: string) => (await (await server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  };

  it("creates a request thread on the component's artboard in the design system, with its origin", async () => {
    const res = await send({});
    expect(res.status).toBe(201);
    const { threadId, pageId } = (await res.json()) as SendRequestResponse;
    expect(pageId).toBe(ds.pageId);

    const [thread] = await threadsOf(ds.pageId);
    expect(thread).toMatchObject({
      id: threadId,
      status: "open",
      body: "A 720 px size",
      target: { kind: "artboard", artboard: "components/modal.html" },
      request: {
        kind: "component",
        state: "in_progress",
        component: "modal",
        origins: [{ projectId: app.id, projectTitle: "App", pageId: planning.id, pageTitle: "Planning", artboard: "planning.html", selector: "#edit" }],
      },
    });
    expect(thread.request!.origins[0]!.threadId).toBeUndefined();
  });

  it("points the origin at the user's comment when Claude routes it", async () => {
    const comment = (await (await server.post(`/api/pages/${planning.id}/threads`, {
      artboard: "planning.html",
      selector: "#edit",
      xPct: 10,
      yPct: 10,
      body: "The cross must be round",
    })).json()) as Thread;

    const { threadId } = (await (await send({ threadId: comment.id })).json()) as SendRequestResponse;

    const request = (await threadsOf(ds.pageId)).find((t) => t.id === threadId)!;
    expect(request.request!.origins[0]).toMatchObject({ threadId: comment.id, pageId: planning.id });
  });

  it("goes straight to the design system's work on the origin project's agent, with no accept step", async () => {
    const agent = await server.connectAgent({ machine: "MacBook", folder: "/work/app", projectId: app.id });
    await agent.hello;

    const { threadId } = (await (await send({})).json()) as SendRequestResponse;

    const received = () => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : [])) as WorkItem[];
    await until(() => received().length === 1);
    expect(received()[0]).toMatchObject({ pageId: ds.pageId, threads: [{ threadId }] });
    expect(received()[0]!.message).toContain("request from the project App");
    expect(received()[0]!.message).toContain("A 720 px size");
  });

  it("refuses a request from a project without a design system, for a component the design system lacks, or from an unknown thread", async () => {
    const lone = (await (await server.post("/api/projects", { title: "Lone" })).json()) as Project;
    const lonePage = (await (await server.post(`/api/projects/${lone.id}/pages`, { title: "Home", files: { "home.html": "<h1>Hi</h1>" } })).json()) as Page;
    expect((await send({ artboard: "home.html" }, lonePage.id)).status).toBe(409);
    expect((await send({ component: "ui-carousel" })).status).toBe(404);
    expect((await send({ threadId: "nope" })).status).toBe(400);
    expect((await send({ artboard: "ghost.html" })).status).toBe(400);
    expect((await send({ missing: "" })).status).toBe(400);
    expect(await threadsOf(ds.pageId)).toEqual([]);
  });

  it("cannot be resolved like a comment, while a plain comment on the component can", async () => {
    const { threadId } = (await (await send({})).json()) as SendRequestResponse;
    const plain = (await (await server.post(`/api/pages/${ds.pageId}/threads`, { target: { kind: "artboard", artboard: "components/modal.html" }, body: "Title is 18 px?" })).json()) as Thread;

    expect((await server.post(`/api/threads/${threadId}/resolve`, {})).status).toBe(409);
    expect((await server.post(`/api/threads/${plain.id}/resolve`, {})).status).toBe(200);
  });

  it("lists the open requests on the design system overview", async () => {
    await send({});
    const detail = (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
    expect(detail.requests).toEqual([
      expect.objectContaining({ pageId: ds.pageId, artboard: "components/modal.html", tag: "ui-modal", title: "A 720 px size", origin: "App · Planning" }),
    ]);
  });
});
