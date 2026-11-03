import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("colour at the top of the page reported by the artboard bridge (what Safari tints its status bar with)", () => {
  let server: TestServer;
  let bridgeSource: string;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "home.html": "<!doctype html><html><body></body></html>" } })).json()) as Page;
    const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
    const src = /<script src="([^"]+bridge\.js[^"]*)"><\/script>/.exec(html)![1]!;
    bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
  });
  afterEach(async () => {
    await server.stop();
  });

  /** jsdom has no layout: `atTop` stands for what is drawn at the top of the viewport, front first. */
  function load(markup: string, atTop?: string[]) {
    const { window } = new JSDOM(`<!doctype html><html>${markup}</html>`, { runScripts: "outside-only" });
    const document = window.document;
    if (atTop) Object.defineProperty(document, "elementsFromPoint", { value: () => atTop.map((selector) => document.querySelector(selector)) });
    const colours: string[] = [];
    window.addEventListener("message", (e) => {
      const data = e.data as { type: string; colour?: string };
      if (data.type === "redline:top-colour") colours.push(data.colour!);
    });
    window.eval(bridgeSource);
    return { window, colours };
  }

  it("reports the first background drawn at the top, a decorative band behind the logo included", async () => {
    const { colours } = load(`<body style="background:#f8f7f4"><div id="band" style="pointer-events:none;background:#0b4a45"></div><a id="logo">Lumora</a></body>`, ["#logo", "#band", "body", "html"]);
    await flush();
    expect(colours).toEqual(["rgb(11, 74, 69)"]);
  });

  it("falls back to the body, then white, and reports again only when it changes", async () => {
    const { window, colours } = load(`<body style="background:#222830"></body>`);
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    expect(colours).toEqual(["rgb(34, 40, 48)"]);
    window.document.body.style.background = "transparent";
    window.dispatchEvent(new window.Event("resize"));
    await flush();
    expect(colours).toEqual(["rgb(34, 40, 48)", "rgb(255, 255, 255)"]);
  });
});
