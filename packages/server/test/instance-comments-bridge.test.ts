import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;

const modalFile = (template: string) =>
  `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const MODAL = modalFile(
  `<div class="modal"><h2><slot name="title"></slot></h2><div class="body"><slot></slot></div><footer><button class="close">Close</button><button class="ok">OK</button></footer></div>`,
);
const MODAL_WITHOUT_FOOTER = modalFile(`<div class="modal"><div class="body"><slot></slot></div></div>`);
const SIZE_TWEAK = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };
const modalManifest = JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [SIZE_TWEAK] });
const pageManifest = (designSystem: string) => JSON.stringify({ designSystem, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [] });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

interface Sent {
  type: string;
  [key: string]: unknown;
}

describe("comments inside component instances (artboard bridge)", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  async function setUp(body: string) {
    const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": modalManifest, "components/modal.html": MODAL } })).json()) as DesignSystem;
    const project = ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
    const page = (await (await server.post(`/api/projects/${project}/pages`, { title: "Flow", files: { "manifest.json": pageManifest(ds.id), "a.html": mockup(body) } })).json()) as Page;
    return { ds, page };
  }

  /** Loads the served artboard (instances and bridge included); layout is stubbed by `rects`, selector to box. */
  async function open(pageId: string, rects: Record<string, [number, number, number, number]> = {}) {
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}/pages/${pageId}/a.html`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    const { window } = dom;
    windows.push(window);
    await new Promise<void>((resolve) => (window.document.readyState === "complete" ? resolve() : window.addEventListener("load", () => resolve())));
    Object.defineProperty(window.document.documentElement, "scrollWidth", { value: 1000 });
    Object.defineProperty(window.document.documentElement, "scrollHeight", { value: 2000 });
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const entry = Object.entries(rects).find(([selector]) => this.matches(selector));
      const [left, top, width, height] = entry?.[1] ?? [0, 0, 0, 0];
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
    };
    const sent: Sent[] = [];
    window.addEventListener("message", (e) => sent.push(e.data as Sent));
    const post = (data: Sent) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { window, sent, post, flush };
  }

  const PAGE = `<main><ui-modal id="confirm"><p>Really?</p></ui-modal></main>`;

  async function pickOk(pageId: string) {
    const { window, sent, post, flush } = await open(pageId);
    post({ type: "redline:set-mode", picking: true });
    window.document.querySelector(".ok")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    return sent.find((m) => m.type === "redline:picked")!.selector as string;
  }

  async function pinPosition(pageId: string, selector: string, rects: Record<string, [number, number, number, number]>) {
    const { sent, post, flush } = await open(pageId, rects);
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector, xPct: 5, yPct: 6 }] });
    await flush();
    return (sent.find((m) => m.type === "redline:pin-positions")!.positions as Sent[])[0];
  }

  it("anchors a pick inside an instance on the instance plus the path within it, and finds the element again after a reload", async () => {
    const { page } = await setUp(PAGE);
    const selector = await pickOk(page.id);
    const [instance, inner] = selector.split(" >>> ");
    expect(instance).toBe("ui-modal#confirm");
    expect(inner).toBeTruthy();

    const position = await pinPosition(page.id, selector, { ".ok": [10, 300, 80, 50] });
    expect(position).toMatchObject({ id: "t1", xPct: 9, yPct: 15, matched: true });
    expect(position.elementGone).toBeFalsy();
  });

  it("keeps a plain selector for an element outside any instance", async () => {
    const { page } = await setUp(`<main><h1 id="title">Hi</h1><ui-modal id="confirm"></ui-modal></main>`);
    const { window, sent, post, flush } = await open(page.id);
    post({ type: "redline:set-mode", picking: true });
    window.document.getElementById("title")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(sent.find((m) => m.type === "redline:picked")!.selector).toBe("#title");
  });

  it("moves the pin onto the instance when the inner element is gone after a diffusion, and says so", async () => {
    const { ds, page } = await setUp(PAGE);
    const selector = await pickOk(page.id);
    await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "manifest.json": modalManifest, "components/modal.html": MODAL_WITHOUT_FOOTER }, message: "Drop footer", origin: "thread" });
    await server.post(`/api/design-systems/${ds.id}/diffusions`, {});

    const position = await pinPosition(page.id, selector, { "ui-modal": [0, 100, 200, 400] });
    expect(position).toMatchObject({ id: "t1", xPct: 20, yPct: 5, matched: true, elementGone: true });
  });

  it("outlines the hovered instance in comment mode with a dashed dark outline and its id as label", async () => {
    const { page } = await setUp(PAGE);
    const { window, post } = await open(page.id, { "ui-modal": [20, 100, 300, 200], ".ok": [30, 250, 80, 30] });
    post({ type: "redline:set-mode", picking: true });
    window.document.querySelector(".ok")!.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));

    const part = (name: string) => window.document.querySelector<HTMLElement>(`#__redline-hover-instance [data-part=${name}]`)!;
    expect(part("label").textContent).toBe("ui-modal · confirm");
    const outline = part("outline");
    expect(outline.style.left).toBe("20px");
    expect(outline.style.top).toBe("100px");
    expect(outline.style.width).toBe("300px");
    expect(outline.style.height).toBe("200px");
    expect(outline.getAttribute("style")).toContain("1.5px dashed #18181B");
    expect(outline.getAttribute("style")).toContain("outline-offset: 4px");
    expect(part("label").style.backgroundColor).toBe("rgb(24, 24, 27)");
    // The label sits above the outline's top-left corner, like the board's.
    expect(part("label").style.left).toBe("14px");
    expect(part("label").style.top).toBe("70px");
    // The hovered element itself keeps the usual outline.
    expect(window.document.querySelector<HTMLElement>("#__redline-hover [data-part=label]")!.textContent).toBe("Bouton · OK");
  });

  it("labels an instance without an id by its main setting, and draws nothing for an element outside instances", async () => {
    const { page } = await setUp(`<main><h1 id="title">Hi</h1><ui-modal><p>x</p></ui-modal></main>`);
    const { window, post } = await open(page.id, { "ui-modal": [20, 100, 300, 200], "#title": [0, 0, 100, 20] });
    post({ type: "redline:set-mode", picking: true });
    const instanceLabel = () => window.document.querySelector<HTMLElement>("#__redline-hover-instance [data-part=label]");
    window.document.querySelector("p")!.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    expect(instanceLabel()!.textContent).toBe("ui-modal · md");
    window.document.getElementById("title")!.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    const root = window.document.getElementById("__redline-hover-instance");
    expect(!root || root.style.display === "none").toBe(true);
  });
});
