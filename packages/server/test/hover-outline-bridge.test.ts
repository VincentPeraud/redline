import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { BRIDGE_PATH } from "../src/bridge.js";

const ARTBOARD = `<!doctype html><html><body>
  <main>
    <h1 id="title">Une nuit</h1>
    <button id="go"><span id="go-inner">Réserver ma place</span></button>
    <div id="plain"></div>
  </main>
</body></html>`;

const RECTS: Record<string, [number, number, number, number]> = {
  title: [22, 60, 200, 30],
  go: [22, 200, 120, 36],
  "go-inner": [30, 206, 100, 24],
  plain: [0, 0, 100, 20],
};

describe("hover outline drawn by the artboard bridge", () => {
  let server: TestServer;
  let bridgeSource: string;

  beforeEach(async () => {
    server = await startTestServer();
    bridgeSource = await (await fetch(`${server.artboardOrigin}${BRIDGE_PATH}`)).text();
  });
  afterEach(async () => {
    await server.stop();
  });

  function load() {
    const dom = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
    const { window } = dom;
    for (const [id, [left, top, width, height]] of Object.entries(RECTS)) {
      window.document.getElementById(id)!.getBoundingClientRect = () =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    }
    window.eval(bridgeSource);
    const mode = (picking: boolean, alt = false) =>
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "redline:set-mode", picking, alt }, source: window }));
    const move = (id: string, init: MouseEventInit = {}) =>
      window.document.getElementById(id)!.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, ...init }));
    const part = (name: "outline" | "label") =>
      window.document.querySelector<HTMLElement>(`#__redline-hover [data-part=${name}]`);
    const shown = () => {
      const root = window.document.getElementById("__redline-hover");
      return !!root && root.style.display !== "none";
    };
    return { window, mode, move, part, shown };
  }

  it("outlines the hovered element in comment mode with finish B and names it", () => {
    const { mode, move, part, shown } = load();
    mode(true);
    move("go");
    expect(shown()).toBe(true);
    const outline = part("outline")!;
    expect(outline.style.left).toBe("22px");
    expect(outline.style.top).toBe("200px");
    expect(outline.style.width).toBe("120px");
    expect(outline.style.height).toBe("36px");
    const css = outline.getAttribute("style")!;
    expect(css).toContain("outline: 2px solid #D92D20");
    expect(css).toContain("outline-offset: 2px");
    expect(css).toContain("box-shadow: 0 0 0 5px #FFFFFF");
    const label = part("label")!;
    expect(label.textContent).toBe("Bouton · Réserver ma place");
    const labelCss = label.getAttribute("style")!;
    expect(label.style.backgroundColor).toBe("rgb(217, 45, 32)");
    expect(label.style.color).toBe("rgb(255, 255, 255)");
    expect(label.style.fontWeight).toBe("600");
    expect(label.style.fontSize).toBe("11px");
    expect(label.style.padding).toBe("4px 6px");
    expect(labelCss).toContain("box-shadow: 0 0 0 1px #FFFFFF");
    expect(label.style.left).toBe("18px");
    expect(label.style.top).toBe("174px");
  });

  it("ignores pointer events and never tints the mock-up", () => {
    const { mode, move, window } = load();
    mode(true);
    move("go");
    const root = window.document.getElementById("__redline-hover")!;
    expect(root.style.pointerEvents).toBe("none");
    expect(root.querySelectorAll("*").length).toBe(2);
    expect(root.innerHTML).not.toMatch(/rgba/);
  });

  it("shows nothing in interactive mode, except while Alt is held", () => {
    const { move, shown } = load();
    move("go");
    expect(shown()).toBe(false);
    move("go", { altKey: true });
    expect(shown()).toBe(true);
    move("go", { altKey: false });
    expect(shown()).toBe(false);
  });

  it("shows and clears the outline when the parent reports Alt, without any mouse move", () => {
    const { mode, move, shown } = load();
    move("go");
    mode(false, true);
    expect(shown()).toBe(true);
    mode(false, false);
    expect(shown()).toBe(false);
  });

  it("follows the mouse from element to element", () => {
    const { mode, move, part } = load();
    mode(true);
    move("go");
    move("title");
    expect(part("outline")!.style.top).toBe("60px");
    expect(part("label")!.textContent).toBe("Titre · Une nuit");
  });

  it("disappears when the mouse leaves the document or comment mode ends", () => {
    const { mode, move, shown, window } = load();
    mode(true);
    move("go");
    window.document.documentElement.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
    expect(shown()).toBe(false);
    move("go");
    expect(shown()).toBe(true);
    mode(false);
    expect(shown()).toBe(false);
  });

  it("stays placed on scroll", () => {
    const { mode, move, part, window } = load();
    mode(true);
    move("go");
    const go = window.document.getElementById("go")!;
    go.getBoundingClientRect = () => ({ left: 22, top: 150, width: 120, height: 36, right: 142, bottom: 186 }) as DOMRect;
    window.dispatchEvent(new window.Event("scroll"));
    expect(part("outline")!.style.top).toBe("150px");
    expect(part("label")!.style.top).toBe("124px");
  });

  it("keeps the label inside the document for an element at the top edge", () => {
    const { mode, move, part } = load();
    mode(true);
    move("plain");
    expect(Number.parseFloat(part("label")!.style.top)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(part("label")!.style.left)).toBeGreaterThanOrEqual(0);
  });

  it("still reports the pick on click and does not alter the page height measure", () => {
    const { mode, move, window } = load();
    const picked: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:picked") picked.push(e.data);
    });
    mode(true);
    move("go");
    window.document.getElementById("go")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(picked).toHaveLength(1);
        resolve();
      }, 0),
    );
  });
});
