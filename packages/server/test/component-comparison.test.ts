import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { AGENT_API_PREFIX, CORE_TOKENS, type AgentCheckout, type AgentTokenResponse, type ComponentComparison, type DesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const componentFile = (name: string, body: string) =>
  `<!doctype html><html><head></head><body><template data-component>${body}</template><ui-${name}></ui-${name}></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 700, y: 0, width: 560, height: 400 })) });
const MODAL_V1 = componentFile("modal", `<div class="modal v1"><p class="help">Help</p></div>`);
const MODAL_V2 = componentFile("modal", `<div class="modal v2"><footer>Footer</footer></div>`);

describe("the before / after comparison of a component", () => {
  let server: TestServer;
  let token: string;
  let ds: DesignSystem;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
    token = ((await (await server.get("/api/agent-token")).json()) as AgentTokenResponse).token;
    ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": MODAL_V1 } })).json()) as DesignSystem;
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  const agent = (path: string, body?: object) =>
    fetch(`${server.url}${AGENT_API_PREFIX}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const publish = async (files: Record<string, string>, changes: object[] = [], drop: string[] = []) => {
    const checkout = (await (await agent(`/pages/${ds.pageId}/files`)).json()) as AgentCheckout;
    const kept = Object.fromEntries(Object.entries(checkout.files).filter(([path]) => !drop.includes(path)));
    const res = await agent(`/pages/${ds.pageId}/versions`, { files: { ...kept, ...files }, message: "Edit", origin: "thread", baseVersionId: checkout.versionId, changes, confirmRemovals: true });
    expect(res.status, await res.clone().text()).toBe(201);
  };
  const comparison = async (name: string) => (await server.get(`/api/design-systems/${ds.id}/components/${name}/comparison`)).json() as Promise<ComponentComparison>;
  const open = async (path: string) => {
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}${path}`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    windows.push(dom.window);
    await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
    return dom.window;
  };

  const threeChanges = [
    { component: "modal", label: "Footer added", kind: "added", anchor: { draft: "footer" } },
    { component: "modal", label: "Help removed", kind: "removed", anchor: { diffused: ".help" } },
    { component: "modal", label: "Look changed", kind: "modified", anchor: { draft: ".modal", diffused: ".modal" } },
    { component: "modal", label: "No anchor", kind: "modified" },
  ];

  it("numbers the changes like the review and puts each marker on the side its kind belongs to", async () => {
    await publish({ "components/modal.html": MODAL_V2 }, threeChanges);
    const result = await comparison("modal");
    expect(result.kind).toBe("changed");
    expect(result.diffusion).toBe(1);
    expect(result.changes.map((change) => change.label)).toEqual(["Footer added", "Help removed", "Look changed", "No anchor"]);
    expect(result.draft!.markers).toEqual([{ number: 1, selector: "footer" }, { number: 3, selector: ".modal" }]);
    expect(result.diffused!.markers).toEqual([{ number: 2, selector: ".help" }, { number: 3, selector: ".modal" }]);
    expect(result.draft).toMatchObject({ url: `/pages/${ds.pageId}/components/modal.html`, width: 560, height: 400 });
    expect(result.diffused!.url).toBe(`/pages/${ds.pageId}/components/modal.html?diffusion=1`);
  });

  it("serves the diffusion's version of the component artboard next to the draft's", async () => {
    await publish({ "components/modal.html": MODAL_V2 });
    const { draft, diffused } = await comparison("modal");
    const before = await open(diffused!.url);
    expect(before.document.querySelector("ui-modal .v1 .help")).not.toBeNull();
    expect(before.document.querySelector("ui-modal .v2")).toBeNull();
    const after = await open(draft!.url);
    expect(after.document.querySelector("ui-modal .v2 footer")).not.toBeNull();
  });

  it("has no diffused side for a new component and no draft side for a removed one", async () => {
    await publish({ "manifest.json": manifestOf(["components/modal.html", "components/tag.html"]), "components/tag.html": componentFile("tag", `<span></span>`) });
    const added = await comparison("tag");
    expect(added.kind).toBe("added");
    expect(added.diffused).toBeUndefined();
    expect(added.draft).toBeDefined();
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
    await publish({ "manifest.json": manifestOf(["components/tag.html"]) }, [], ["components/modal.html"]);
    const removed = await comparison("modal");
    expect(removed.kind).toBe("removed");
    expect(removed.draft).toBeUndefined();
    expect(removed.diffused).toBeDefined();
  });

  it("answers 404 for a component that did not change", async () => {
    expect((await server.get(`/api/design-systems/${ds.id}/components/modal/comparison`)).status).toBe(404);
    expect((await server.get(`/api/design-systems/nope/components/modal/comparison`)).status).toBe(404);
  });

  it("draws the numbered markers in the artboard and hides them on request", async () => {
    await publish({ "components/modal.html": MODAL_V2 }, threeChanges);
    const { draft } = await comparison("modal");
    const window = await open(draft!.url);
    const post = (data: object) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    post({ type: "redline:set-compare-markers", visible: true, markers: draft!.markers });
    const badges = [...window.document.querySelectorAll("#__redline-compare [data-part=badge]")].map((el) => el.textContent);
    expect(badges).toEqual(["1", "3"]);
    post({ type: "redline:set-compare-markers", visible: false, markers: draft!.markers });
    expect(window.document.querySelectorAll("#__redline-compare [data-part=badge]")).toHaveLength(0);
  });
});
