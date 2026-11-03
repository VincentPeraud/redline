import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_API_PREFIX,
  CORE_TOKENS,
  type AgentCheckout,
  type AgentTokenResponse,
  type DesignSystem,
  type DesignSystemDetail,
  type DesignSystemSummary,
  type DiffusionReview,
  type HomeOverview,
  type Page,
  type Project,
  type SendRequestResponse,
} from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000000"};`).join("\n")}\n}\n`;
const componentFile = (name: string, template: string) =>
  `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component>${template}</template></body></html>`;
const MODAL = componentFile("modal", `<div class="modal"><slot></slot></div>`);
const BUTTON = componentFile("button", `<button><slot></slot></button>`);
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: [] });

describe("alerts for design systems to diffuse", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let quiet: DesignSystem;
  let planning: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    const create = async (title: string) =>
      (await (await server.post("/api/design-systems", {
        title,
        files: {
          "tokens.css": tokensCss("#111111"),
          "manifest.json": manifestOf(["components/modal.html", "components/button.html"]),
          "components/modal.html": MODAL,
          "components/button.html": BUTTON,
        },
      })).json()) as DesignSystem;
    ds = await create("Lumora");
    quiet = await create("Réseaux sociaux");
    const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    planning = (await (await server.post(`/api/projects/${app.id}/pages`, {
      title: "Planning",
      files: { "manifest.json": manifestOf(["page.html"], ds.id), "page.html": "<!doctype html><html><body><ui-modal></ui-modal></body></html>" },
    })).json()) as Page;
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
  const publish = async (files: Record<string, string>, changes: object[] = []) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    const res = await agent(`/pages/${ds.pageId}/versions`, { files: { ...checkout.files, ...files }, message: "Edit", origin: "thread", baseVersionId: checkout.versionId, changes, confirmRemovals: true });
    expect(res.status, await res.clone().text()).toBe(201);
  };
  const summaryOf = async (id: string) => ((await (await server.get("/api/design-systems")).json()) as DesignSystemSummary[]).find((s) => s.id === id)!;

  async function makeChanges() {
    const { threadId } = (await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "A wide size", artboard: "page.html", selector: "ui-modal" })).json()) as SendRequestResponse;
    await publish(
      {
        "tokens.css": tokensCss("#222222"),
        "components/modal.html": MODAL.replace('modal"', 'modal wide"'),
        "components/button.html": BUTTON.replace("<button>", '<button class="b">'),
      },
      [
        { component: "ui-modal", label: "Wide size", kind: "modified", threadId },
        { component: "modal", label: "Round cross", kind: "modified" },
      ],
    );
  }

  it("counts pending changes as the review's lines, and the open requests", async () => {
    expect(await summaryOf(ds.id)).toMatchObject({ pendingChanges: 0, requests: 0 });
    await makeChanges();
    const review = (await (await server.get(`/api/design-systems/${ds.id}/review`)).json()) as DiffusionReview;
    const lines = review.tokens.length + (review.designMdChanged ? 1 : 0) + review.components.reduce((sum, c) => sum + c.changes.length, 0);
    // 1 token + 2 recorded modal changes + 1 button change without description
    expect(lines).toBe(4);
    expect(await summaryOf(ds.id)).toMatchObject({ pendingChanges: 4, requests: 1 });
    expect(await summaryOf(quiet.id)).toMatchObject({ pendingChanges: 0, requests: 0 });
    const detail = (await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail;
    expect(detail.reviewLines).toBe(4);
  });

  it("tells the home how many design systems have changes to diffuse", async () => {
    const home = async () => ((await (await server.get("/api/home")).json()) as HomeOverview).designSystemsToDiffuse;
    expect(await home()).toBe(0);
    await makeChanges();
    expect(await home()).toBe(1);
  });
});
