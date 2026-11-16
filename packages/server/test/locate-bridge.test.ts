import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { startTestServer, type TestServer } from "@redline/server/test-harness";
import { BRIDGE_PATH } from "../src/bridge.js";

const ARTBOARD = `<!doctype html><html><body><main><button id="go">Go</button></main></body></html>`;

describe("locating an element through the artboard bridge", () => {
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
    const located: unknown[] = [];
    window.addEventListener("message", (e) => {
      if ((e.data as { type: string }).type === "redline:located") located.push(e.data);
    });
    window.eval(bridgeSource);
    const post = (data: object) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    return { post, located };
  }

  it("reports the top of the element in page pixels", async () => {
    const { post, located } = load();
    post({ type: "redline:locate", selector: "main > button" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(located).toEqual([{ type: "redline:located", selector: "main > button", top: 200 }]);
  });

  it("reports nothing for a selector that matches no element", async () => {
    const { post, located } = load();
    post({ type: "redline:locate", selector: "#nowhere" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(located).toEqual([]);
  });
});
