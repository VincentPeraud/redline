import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const MODAL = `<!doctype html><html><head></head><body><template data-component><div class="modal"><div class="body"><slot></slot></div><button class="ok">OK</button></div></template></body></html>`;
const SIZE_TWEAK = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };
const modalManifest = JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [SIZE_TWEAK] });
const pageManifest = (designSystem: string) => JSON.stringify({ designSystem, artboards: [{ file: "a.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [] });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

interface Sent {
  type: string;
  [key: string]: unknown;
}

describe("remembered instance state (artboard bridge)", () => {
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
    return page;
  }

  async function open(pageId: string) {
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}/pages/${pageId}/a.html`, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
    const { window } = dom;
    windows.push(window);
    await new Promise<void>((resolve) => (window.document.readyState === "complete" ? resolve() : window.addEventListener("load", () => resolve())));
    Object.defineProperty(window.document.documentElement, "scrollWidth", { value: 1000 });
    Object.defineProperty(window.document.documentElement, "scrollHeight", { value: 2000 });
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const [left, top, width, height] = this.matches(".ok") ? [10, 300, 80, 50] : [0, 0, 0, 0];
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} } as DOMRect;
    };
    const sent: Sent[] = [];
    window.addEventListener("message", (e) => sent.push(e.data as Sent));
    const post = (data: Sent) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    /** Waits for the bridge to answer instead of guessing how long it takes under load. */
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(condition()).toBe(true);
    };
    const pick = async () => {
      post({ type: "redline:set-mode", picking: true });
      window.document.querySelector(".ok")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flush();
      return sent.filter((m) => m.type === "redline:picked").pop()!;
    };
    const lastPositions = () => (sent.filter((m) => m.type === "redline:pin-positions").pop()?.positions ?? []) as Sent[];
    return { window, sent, post, flush, until, pick, lastPositions };
  }

  const PAGE = `<main><ui-modal id="confirm"><p>Really?</p></ui-modal></main>`;

  it("reports the instances that left their initial state when a comment is picked, and nothing when none did", async () => {
    const page = await setUp(PAGE);
    const closed = await open(page.id);
    expect((await closed.pick()).instanceState).toBeUndefined();

    const shown = await open(page.id);
    shown.window.document.getElementById("confirm")!.setAttribute("open", "");
    expect((await shown.pick()).instanceState).toEqual([{ selector: "ui-modal#confirm", attributes: { open: "" } }]);
  });

  it("keeps the pin hidden until the state is replayed, then sets the state and shows it", async () => {
    const page = await setUp(PAGE);
    const { window, post, until, lastPositions } = await open(page.id);
    const state = [{ selector: "ui-modal#confirm", attributes: { open: "" } }];
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "ui-modal#confirm >>> div > button", xPct: 5, yPct: 6, instanceState: state }] });
    await until(() => lastPositions()[0]?.hidden === true);
    expect(lastPositions()[0]).toMatchObject({ id: "t1", hidden: true });

    post({ type: "redline:replay-state", id: "t1" });
    await until(() => lastPositions()[0]?.matched === true && !lastPositions()[0]!.hidden);
    expect(window.document.getElementById("confirm")!.hasAttribute("open")).toBe(true);
    expect(lastPositions()[0]).toMatchObject({ id: "t1", matched: true });

    window.document.getElementById("confirm")!.removeAttribute("open");
    await until(() => lastPositions()[0]?.hidden === true);
    expect(lastPositions()[0]).toMatchObject({ id: "t1", hidden: true });
  });

  it("skips a state whose instance or setting value is gone, names it, and shows the pin on what remains", async () => {
    const page = await setUp(PAGE);
    const { window, post, flush, lastPositions } = await open(page.id);
    const state = [
      { selector: "ui-modal#confirm", attributes: { open: "" } },
      { selector: "ui-modal#removed", attributes: { open: "" } },
      { selector: "ui-modal#confirm", attributes: { size: "xl" } },
    ];
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "ui-modal#confirm", xPct: 5, yPct: 6, instanceState: state }] });
    post({ type: "redline:replay-state", id: "t1" });
    await flush();
    const instance = window.document.getElementById("confirm")!;
    expect(instance.hasAttribute("open")).toBe(true);
    expect(instance.getAttribute("size")).not.toBe("xl");
    expect(lastPositions()[0]).toMatchObject({ id: "t1", matched: true, missingState: [1, 2] });
    expect(lastPositions()[0]!.hidden).toBeFalsy();
  });

  it("shows the pin at once when nothing of its state can be replayed", async () => {
    const page = await setUp(PAGE);
    const { post, flush, lastPositions } = await open(page.id);
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "main", xPct: 5, yPct: 6, instanceState: [{ selector: "ui-modal#removed", attributes: { open: "" } }] }] });
    await flush();
    expect(lastPositions()[0]).toMatchObject({ id: "t1", matched: true, missingState: [0] });
    expect(lastPositions()[0]!.hidden).toBeFalsy();
  });
});
