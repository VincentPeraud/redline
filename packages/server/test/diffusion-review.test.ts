import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type DesignSystem, type DiffusionReview, type Page, type Project, type SendRequestResponse } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000000"};`).join("\n")}\n}\n`;
const componentFile = (name: string, template: string) =>
  `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component>${template}</template></body></html>`;
const MODAL = componentFile("modal", `<div class="modal"><slot></slot></div>`);
const BUTTON = componentFile("button", `<button><slot></slot></button>`);
const PICKER = componentFile("picker", `<div class="picker"></div>`);
const sizeTweak = (options: string[], fallback: string) => ({ id: "size", type: "choice", label: "Size", options, default: fallback, artboard: "components/modal.html" });
const manifestOf = (files: string[], tweaks: object[] = [], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })), tweaks });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

describe("the diffusion review", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  let app: Project;
  let site: Project;
  let planning: Page;

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", {
      title: "Lumora",
      files: {
        "tokens.css": tokensCss("#111111"),
        "manifest.json": manifestOf(["components/modal.html", "components/button.html"], [sizeTweak(["sm", "md"], "md")]),
        "components/modal.html": MODAL,
        "components/button.html": BUTTON,
      },
    })).json()) as DesignSystem;
    app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
    site = (await (await server.post("/api/projects", { title: "Site public", designSystem: ds.id })).json()) as Project;
    const page = async (project: Project, title: string, body: string, extra: Record<string, string> = {}) =>
      (await (await server.post(`/api/projects/${project.id}/pages`, {
        title,
        files: { "manifest.json": manifestOf(["page.html", ...Object.keys(extra)], [], ds.id), "page.html": mockup(body), ...extra },
      })).json()) as Page;
    planning = await page(app, "Planning", `<ui-modal></ui-modal><ui-modal size="sm"></ui-modal>`);
    await page(app, "Annonces", `<p>No modal</p>`);
    // The site already has its own picker, which the design system will happen to get too.
    await page(site, "Inscription", `<ui-modal></ui-modal><ui-picker></ui-picker>`, { "components/picker.html": PICKER });
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
  const review = async () => (await (await server.get(`/api/design-systems/${ds.id}/review`)).json()) as DiffusionReview;
  /** The design system's session publishes new files, with the changes it recorded. */
  const publish = async (files: Record<string, string>, changes: object[] = []) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    const res = await agent(`/pages/${ds.pageId}/versions`, { files: { ...checkout.files, ...files }, message: "Edit", origin: "thread", baseVersionId: checkout.versionId, changes, confirmRemovals: true });
    expect(res.status, await res.clone().text()).toBe(201);
  };
  const ask = async (missing: string) =>
    ((await (await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing, artboard: "page.html", selector: "ui-modal" })).json()) as SendRequestResponse).threadId;

  it("is empty while nothing is pending", async () => {
    expect(await review()).toEqual({ tokens: [], designMdChanged: false, projects: ["App", "Site public"], components: [] });
  });

  it("lists the changed tokens before and after, and a DESIGN.md change", async () => {
    await publish({ "tokens.css": tokensCss("#222222") });
    await fetch(`${server.url}/api/projects/${ds.id}/design-md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "# New rule" }) });
    const { tokens, designMdChanged } = await review();
    expect(tokens).toEqual([{ name: "--color-primary", kind: "changed", from: "#111111", to: "#222222" }]);
    expect(designMdChanged).toBe(true);
  });

  it("gives a component its changes with their origins, and counts its instances over the pages of the following projects", async () => {
    const requested = await ask("A 720 px size");
    await publish(
      { "components/modal.html": MODAL.replace("modal\"", "modal wide\"") },
      [
        { component: "ui-modal", label: "Taille 720 px", kind: "modified", threadId: requested },
        { component: "modal", label: "Croix ronde", kind: "modified" },
      ],
    );
    const modal = (await review()).components.find((c) => c.name === "modal")!;
    expect(modal.kind).toBe("changed");
    expect(modal.changes).toEqual([
      expect.objectContaining({ label: "Taille 720 px", origin: { kind: "request", from: ["App · Planning"] }, refusable: true, changeId: expect.any(String) }),
      expect.objectContaining({ label: "Croix ronde", origin: { kind: "direct" }, refusable: false }),
    ]);
    expect(modal.where).toEqual({
      instances: 3,
      pages: [
        { projectTitle: "App", pageId: planning.id, pageTitle: "Planning", instances: 2 },
        expect.objectContaining({ projectTitle: "Site public", pageTitle: "Inscription", instances: 1 }),
      ],
      keptBy: [],
    });
  });

  it("says a component changed without any record is a change without description", async () => {
    await publish({ "components/button.html": BUTTON.replace("<button>", "<button class=\"b\">") });
    const button = (await review()).components.find((c) => c.name === "button")!;
    expect(button.changes).toEqual([{ label: "Modification sans description", origin: { kind: "direct" }, refusable: false }]);
    expect(button.where).toEqual({ instances: 0, pages: [], keptBy: [] });
  });

  it("shows a confirmed default change as a line, and marks a new component a project already has as kept by it", async () => {
    await publish({
      "manifest.json": manifestOf(["components/modal.html", "components/button.html", "components/picker.html"], [sizeTweak(["sm", "md", "lg"], "lg")]),
      "components/picker.html": PICKER,
    });
    const { components } = await review();
    expect(components.find((c) => c.name === "modal")!.changes).toEqual([{ label: "Valeur par défaut de size : md → lg", origin: { kind: "direct" }, refusable: false }]);
    const picker = components.find((c) => c.name === "picker")!;
    expect(picker.kind).toBe("added");
    expect(picker.where).toEqual({ instances: 0, pages: [], keptBy: ["Site public"] });
  });

  it("shows the user's comment as the origin when the request was routed from one", async () => {
    const comment = (await (await server.post(`/api/pages/${planning.id}/threads`, { target: { kind: "artboard", artboard: "page.html" }, title: "Cross", body: "Make the cross round" })).json()) as { id: string };
    const res = await agent(`/pages/${planning.id}/requests`, { component: "ui-modal", missing: "Round cross", artboard: "page.html", threadId: comment.id });
    const { threadId } = (await res.json()) as SendRequestResponse;
    await publish({ "components/modal.html": MODAL.replace('modal"', 'modal x"') }, [{ component: "modal", label: "Croix ronde", kind: "modified", threadId }]);
    expect((await review()).components[0]!.changes[0]!.origin).toEqual({ kind: "comment", from: ["App · Planning"] });
  });
});
