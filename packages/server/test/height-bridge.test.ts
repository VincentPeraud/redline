import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ARTBOARD = `<!doctype html><html><body><main><h1>Hi</h1></main></body></html>`;

describe("document height reported by the artboard bridge", () => {
  let server: TestServer;
  let bridgeSource: string;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "home.html": ARTBOARD } })).json()) as Page;
    const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
    const src = /<script src="([^"]+bridge\.js[^"]*)"><\/script>/.exec(html)![1]!;
    bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
  });
  afterEach(async () => {
    await server.stop();
  });

  /** jsdom has no layout: the page height is whatever the test says. */
  function load(height: { html: number; body: number }) {
    const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
    const size = { ...height };
    Object.defineProperty(window.document.documentElement, "offsetHeight", { get: () => size.html });
    Object.defineProperty(window.document.body, "scrollHeight", { get: () => size.body });
    const heights: number[] = [];
    window.addEventListener("message", (e) => {
      const data = e.data as { type: string; height?: number };
      if (data.type === "redline:doc-height") heights.push(data.height!);
    });
    window.eval(bridgeSource);
    return { window, heights, size };
  }

  it("reports the height of the page when it loads", async () => {
    const { heights } = load({ html: 1100, body: 1100 });
    await flush();
    expect(heights).toEqual([1100]);
  });

  it("reports the content height even when a child overflows the body", async () => {
    const { heights } = load({ html: 900, body: 2400 });
    await flush();
    expect(heights).toEqual([2400]);
  });

  it("reports again when the page height changes, and stays quiet when it does not", async () => {
    const { window, heights, size } = load({ html: 1100, body: 1100 });
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    expect(heights).toEqual([1100]);
    size.html = size.body = 1500;
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    expect(heights).toEqual([1100, 1500]);
  });

  it("reports again after the tweaks changed the layout", async () => {
    const { window, heights, size } = load({ html: 1100, body: 1100 });
    size.html = size.body = 1300;
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "redline:set-tweaks", values: { layout: "grid" } }, source: window }));
    await flush();
    expect(heights).toEqual([1100, 1300]);
  });
});
