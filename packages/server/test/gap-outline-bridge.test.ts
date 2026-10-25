import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { BRIDGE_PATH } from "../src/bridge.js";

const ARTBOARD = `<!doctype html><html><body><main><button id="go">Go</button></main></body></html>`;

describe("gap outline drawn by the artboard bridge", () => {
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
    window.document.getElementById("go")!.getBoundingClientRect = () =>
      ({ left: 20, top: 200, width: 120, height: 36, right: 140, bottom: 236, x: 20, y: 200, toJSON() {} }) as DOMRect;
    const rects: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:gap-rect") rects.push(e.data);
    });
    window.eval(bridgeSource);
    const post = (data: object) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    const outline = () => window.document.querySelector<HTMLElement>("#__redline-gap");
    return { post, rects, outline };
  }

  it("outlines the element and reports its box in page pixels", async () => {
    const { post, rects, outline } = load();
    post({ type: "redline:set-gap", selector: "main > button" });
    expect(outline()!.style.cssText).toContain("dashed");
    expect(outline()!.style.left).toBe("20px");
    expect(outline()!.style.height).toBe("36px");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rects).toEqual([{ type: "redline:gap-rect", x: 20, y: 200, width: 120, height: 36 }]);
  });

  it("clears the outline, and reports nothing for a selector that matches no element", async () => {
    const { post, rects, outline } = load();
    post({ type: "redline:set-gap", selector: "main > button" });
    post({ type: "redline:set-gap", selector: null });
    expect(outline()).toBeNull();
    post({ type: "redline:set-gap", selector: "#nowhere" });
    expect(outline()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rects).toHaveLength(1);
  });
});
