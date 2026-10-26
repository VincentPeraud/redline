import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ARTBOARD = `<!doctype html><html><head><title>Paiement</title></head><body><main><h1>Paiement</h1><img src="assets/hero.jpg"></main></body></html>`;

describe("errors reported by the artboard", () => {
  let server: TestServer;
  let html: string;
  let scripts: Record<string, string>;

  beforeEach(async () => {
    server = await startTestServer();
    const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
    const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Onboarding", files: { "paiement.html": ARTBOARD } })).json()) as Page;
    html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/paiement.html`)).text();
    scripts = {};
    for (const [, src] of html.matchAll(/<script src="([^"]+)"><\/script>/g)) {
      scripts[src!] = await (await fetch(new URL(src!, server.artboardOrigin))).text();
    }
  });
  afterEach(async () => {
    await server.stop();
  });

  /** Runs the served scripts in document order, `before` the bridge (the page's own scripts run between them). */
  function load(between: (window: JSDOM["window"]) => void = () => undefined) {
    const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
    const reports: string[][] = [];
    window.addEventListener("message", (e) => {
      const data = e.data as { type: string; errors?: string[] };
      if (data.type === "redline:errors") reports.push(data.errors!);
    });
    const [catcher, bridge] = Object.keys(scripts);
    window.eval(scripts[catcher!]!);
    between(window);
    window.eval(scripts[bridge!]!);
    return { window, reports, last: () => reports[reports.length - 1] };
  }

  function scriptError(window: JSDOM["window"], message: string, lineno?: number) {
    window.dispatchEvent(new window.ErrorEvent("error", { message, lineno, filename: window.location.href }));
  }

  it("catches errors from the very start of the document, before any of the page's scripts", () => {
    expect(html.indexOf("<script")).toBeLessThan(html.indexOf("<title>"));
    expect(Object.keys(scripts)).toHaveLength(2);
  });

  it("puts the catcher after the doctype of a document without a head, and never inside a <header>", async () => {
    const { injectBridge } = await import("../src/bridge.js");
    const served = injectBridge("<!doctype html><header><script>boot()</script></header><body></body>");
    expect(served.startsWith('<!doctype html><script src="/__redline/errors.js"></script><header>')).toBe(true);
  });

  it("reports a script error of the page with its line, even one raised before the bridge loaded", async () => {
    const { last } = load((window) => scriptError(window, "Uncaught TypeError: Cannot read properties of undefined (reading 'map')", 42));
    await flush();
    expect(last()).toEqual(["TypeError: Cannot read properties of undefined (reading 'map') · ligne 42"]);
  });

  it("reports an empty list once the bridge is ready, so a page without errors clears the count", async () => {
    const { reports } = load();
    await flush();
    expect(reports).toEqual([[]]);
  });

  it("names the missing file of an image, a script and a stylesheet", async () => {
    const { window, last } = load();
    const fail = (html: string) => {
      const holder = window.document.createElement("div");
      holder.innerHTML = html;
      const el = holder.firstElementChild!;
      window.document.body.appendChild(el);
      el.dispatchEvent(new window.Event("error"));
    };
    fail(`<img src="assets/hero.jpg">`);
    fail(`<script src="app.js"></script>`);
    fail(`<link rel="stylesheet" href="extra.css">`);
    await flush();
    expect(last()).toEqual(["Image introuvable : assets/hero.jpg", "Script introuvable : app.js", "Feuille de style introuvable : extra.css"]);
  });

  it("reports a promise rejected without a handler", async () => {
    const { window, last } = load();
    const event = new window.Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = new Error("réseau indisponible");
    window.dispatchEvent(event);
    await flush();
    expect(last()).toEqual(["Promesse rejetée : Error: réseau indisponible"]);
  });

  it("says when the browser hides the detail of an error from another origin", async () => {
    const { window, last } = load();
    scriptError(window, "Script error.");
    await flush();
    expect(last()).toEqual(["Erreur dans un script chargé (le navigateur en masque le détail)"]);
  });

  it("reports each message once, and at most 20 of them", async () => {
    const { window, reports, last } = load();
    scriptError(window, "Error: boom", 3);
    scriptError(window, "Error: boom", 3);
    for (let i = 0; i < 30; i++) scriptError(window, `Error: n${i}`, 1);
    await flush();
    expect(last()).toHaveLength(20);
    expect(last()![0]).toBe("Error: boom · ligne 3");
    expect(reports.filter((r) => r.length === 1)).toHaveLength(1);
  });
});
