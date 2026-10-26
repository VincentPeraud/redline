import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const ARTBOARD = `<!doctype html><html><body>
  <main><h1 id="title">Hi</h1><ul><li>a</li><li id="second">b</li></ul></main>
</body></html>`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Sent {
  type: string;
  [key: string]: unknown;
}

describe("pin bridge inside an artboard", () => {
  let server: TestServer;
  let bridgeSource: string;
  let artboardHtml: string;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const res = await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: { "home.html": ARTBOARD },
    });
    const page = (await res.json()) as Page;
    const served = await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`);
    artboardHtml = await served.text();
    const src = /<script src="([^"]+bridge\.js)"><\/script>/.exec(artboardHtml)?.[1];
    expect(src).toBeDefined();
    bridgeSource = await (await fetch(new URL(src!, server.artboardOrigin))).text();
  });
  afterEach(async () => {
    await server.stop();
  });

  /** Loads the artboard in jsdom with the served bridge; layout is stubbed (jsdom has none). */
  function load(html: string = ARTBOARD) {
    const dom = new JSDOM(html, { runScripts: "outside-only" });
    const { window } = dom;
    Object.defineProperty(window.document.documentElement, "scrollWidth", { value: 1000 });
    Object.defineProperty(window.document.documentElement, "scrollHeight", { value: 2000 });
    const sent: Sent[] = [];
    window.addEventListener("message", (e) => {
      const data = e.data as Sent;
      if (data.type.startsWith("redline:") && ["ready", "picked", "pin-positions"].includes(data.type.slice(8))) {
        sent.push(data);
      }
    });
    const place = (selector: string, left: number, top: number) => {
      window.document.querySelector(selector)!.getBoundingClientRect = () =>
        ({ left, top, width: 100, height: 50, right: left + 100, bottom: top + 50 }) as DOMRect;
    };
    const post = (data: Sent) =>
      window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
    window.eval(bridgeSource);
    return { window, sent, place, post };
  }

  it("serves the bridge script from the artboard origin and injects it into artboard HTML", async () => {
    expect(artboardHtml).toContain('<h1 id="title">Hi</h1>');
    expect(bridgeSource).toContain("redline:picked");
  });

  it("reports the clicked element's selector and click position when picking", async () => {
    const { window, sent, post } = load();
    post({ type: "redline:set-mode", picking: true });
    const li = window.document.getElementById("second")!;
    const click = new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 250, clientY: 500 });
    li.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    await flush();
    const picked = sent.find((m) => m.type === "redline:picked")!;
    expect(picked).toMatchObject({ selector: "#second", xPct: 25, yPct: 25 });
    expect(window.document.querySelector(picked.selector as string)).toBe(li);
  });

  it("builds a selector that finds the element again when it has no id", async () => {
    const { window, sent, post } = load();
    post({ type: "redline:set-mode", picking: true });
    const li = window.document.querySelector("li")!;
    li.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await flush();
    const picked = sent.find((m) => m.type === "redline:picked")!;
    expect(window.document.querySelector(picked.selector as string)).toBe(li);
  });

  it("lets clicks through when not picking, except Alt+click which always picks", async () => {
    const { window, sent } = load();
    const h1 = window.document.getElementById("title")!;
    const plain = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    h1.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    await flush();
    expect(sent.some((m) => m.type === "redline:picked")).toBe(false);

    h1.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }));
    await flush();
    expect(sent.some((m) => m.type === "redline:picked")).toBe(true);
  });

  it("places a pin on the artboard's right edge, level with its element, when the selector matches", async () => {
    const { sent, place, post } = load();
    place("#title", 100, 200);
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "#title", xPct: 90, yPct: 90 }] });
    await flush();
    const positions = sent.find((m) => m.type === "redline:pin-positions")!.positions;
    expect(positions).toEqual([{ id: "t1", xPct: 100, yPct: 11.25, matched: true }]);
  });

  it("falls back to the percentage position when the selector no longer matches", async () => {
    const { sent, post } = load();
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "#removed", xPct: 40, yPct: 60 }] });
    await flush();
    const positions = sent.find((m) => m.type === "redline:pin-positions")!.positions;
    expect(positions).toEqual([{ id: "t1", xPct: 40, yPct: 60, matched: false }]);
  });

  it("falls back instead of throwing on an invalid selector", async () => {
    const { sent, post } = load();
    post({ type: "redline:set-pins", pins: [{ id: "t1", selector: "!!", xPct: 5, yPct: 6 }] });
    await flush();
    const positions = sent.find((m) => m.type === "redline:pin-positions")!.positions;
    expect(positions).toEqual([{ id: "t1", xPct: 5, yPct: 6, matched: false }]);
  });

  it("announces itself to the parent once loaded", async () => {
    const { sent } = load();
    await flush();
    expect(sent.some((m) => m.type === "redline:ready")).toBe(true);
  });
});
