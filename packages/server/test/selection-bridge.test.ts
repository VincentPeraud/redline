import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { BRIDGE_PATH } from "../src/bridge.js";

const ARTBOARD = `<!doctype html><html><body>
  <main>
    <button id="go">Réserver ma place</button>
    <div id="card">La maison hantée</div>
  </main>
</body></html>`;

const RECTS: Record<string, [number, number, number, number]> = {
  go: [22, 200, 120, 36],
  card: [22, 300, 300, 80],
};

describe("selection mode and numbered marks drawn by the artboard bridge", () => {
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
    const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
    for (const [id, [left, top, width, height]] of Object.entries(RECTS)) {
      window.document.getElementById(id)!.getBoundingClientRect = () =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    }
    const picked: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:picked") picked.push(e.data);
    });
    window.eval(bridgeSource);
    const post = (data: object) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    const mark = (n: number) => window.document.querySelector<HTMLElement>(`#__redline-marks [data-mark="${n}"]`);
    const part = (n: number, name: "outline" | "badge") => mark(n)?.querySelector<HTMLElement>(`[data-part=${name}]`) ?? null;
    return { window, post, picked, mark, part };
  }

  it("hovers and reports picks in selection mode, like comment mode", () => {
    const { window, post, picked } = load();
    post({ type: "redline:set-mode", picking: false, selecting: true, alt: false });
    window.document.getElementById("go")!.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true }));
    expect(window.document.getElementById("__redline-hover")!.style.display).not.toBe("none");
    expect(window.document.documentElement.style.cursor).toBe("crosshair");
    window.document.getElementById("go")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(picked).toHaveLength(1);
        resolve();
      }, 0),
    );
  });

  it("hands Escape back to the parent in selection mode only, since the iframe holds the keyboard focus", () => {
    const { window, post } = load();
    const keys: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:escape") keys.push(e.data);
    });
    const escape = () => window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    escape();
    post({ type: "redline:set-mode", picking: false, selecting: true, alt: false });
    escape();
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(keys).toHaveLength(1);
        resolve();
      }, 0),
    );
  });

  it("draws a numbered mark with the finish outline on each matching element", () => {
    const { post, part } = load();
    post({ type: "redline:set-marks", marks: [{ number: 1, selector: "#go" }, { number: 3, selector: "#card" }, { number: 2, selector: "#gone" }] });
    const outline = part(1, "outline")!;
    expect(outline.style.left).toBe("22px");
    expect(outline.style.top).toBe("200px");
    expect(outline.style.width).toBe("120px");
    const css = outline.getAttribute("style")!;
    expect(css).toContain("outline: 2px solid #D92D20");
    expect(css).toContain("box-shadow: 0 0 0 5px #FFFFFF");
    const badge = part(1, "badge")!;
    expect(badge.textContent).toBe("1");
    expect(badge.style.left).toBe("8px");
    expect(badge.style.top).toBe("186px");
    expect(badge.style.width).toBe("22px");
    expect(badge.style.height).toBe("22px");
    expect(badge.style.borderRadius).toBe("50%");
    expect(badge.style.backgroundColor).toBe("rgb(217, 45, 32)");
    expect(badge.getAttribute("style")).toContain("box-shadow: 0 0 0 2px #FFFFFF");
    expect(part(3, "badge")!.textContent).toBe("3");
    expect(part(2, "badge")).toBeNull();
  });

  it("ignores pointer events, follows scroll and clears when the marks are cleared", () => {
    const { window, post, part, mark } = load();
    post({ type: "redline:set-marks", marks: [{ number: 1, selector: "#go" }] });
    expect(window.document.getElementById("__redline-marks")!.style.pointerEvents).toBe("none");
    window.document.getElementById("go")!.getBoundingClientRect = () => ({ left: 22, top: 150, width: 120, height: 36, right: 142, bottom: 186 }) as DOMRect;
    window.dispatchEvent(new window.Event("scroll"));
    expect(part(1, "outline")!.style.top).toBe("150px");
    post({ type: "redline:set-marks", marks: [] });
    expect(mark(1)).toBeNull();
  });
});
