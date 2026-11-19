import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { CORE_TOKENS, type DesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const BUTTON =
  `<!doctype html><html lang="fr"><head><style data-component>ui-button[open]{outline:1px solid}</style><script>window.headRan = true;</script></head>` +
  `<body style="display:grid;padding:40px"><template data-component><button class="b"><slot name="icon"><ui-icon></ui-icon></slot><slot></slot><em><slot name="hint" data-label="Aide">Aide par défaut</slot></em></button></template>` +
  `<ui-button id="a" variant="ghost"><span slot="hint"></span></ui-button><ui-button>Publier l'annonce</ui-button><script>window.bodyRan = true;</script></body></html>`;
const ICON = `<!doctype html><html><body><template data-component><i>★</i></template></body></html>`;
const TWEAKS = [
  { id: "variant", type: "choice", label: "Variante", options: ["primary", "ghost"], artboard: "components/button.html" },
  { id: "fullWidth", type: "toggle", label: "Pleine largeur", artboard: "components/button.html" },
];

describe("component sandbox document", () => {
  let server: TestServer;
  const windows: JSDOM["window"][] = [];

  beforeEach(async () => {
    server = await startTestServer();
  });
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close();
    await server.stop();
  });

  async function openSandbox(file = "components/button.html") {
    const manifest = JSON.stringify({ artboards: ["components/button.html", "components/icon.html"].map((f, i) => ({ file: f, x: i * 300, y: 0, width: 200, height: 100 })), tweaks: TWEAKS });
    const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": manifest, "components/button.html": BUTTON, "components/icon.html": ICON } })).json()) as DesignSystem;
    const messages: { type: string; [key: string]: unknown }[] = [];
    const dom = await JSDOM.fromURL(`${server.artboardOrigin}/pages/${ds.pageId}/${file}?sandbox=1`, {
      runScripts: "dangerously",
      resources: "usable",
      pretendToBeVisual: true,
      beforeParse(window) {
        // The sandbox talks to its parent; in jsdom the parent is the window itself.
        const post = window.postMessage.bind(window);
        window.postMessage = ((data: { type: string }, origin: string) => {
          messages.push(data as { type: string });
          post(data, origin);
        }) as typeof window.postMessage;
      },
    });
    windows.push(dom.window);
    await new Promise<void>((resolve) => (dom.window.document.readyState === "complete" ? resolve() : dom.window.addEventListener("load", () => resolve())));
    const window = dom.window;
    const set = (trial: object) => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "redline:sandbox-set", trial }, source: window.parent }));
    return { window, messages, set };
  }

  it("serves the file's head without its scripts and its body inert, with an empty stage", async () => {
    const { window } = await openSandbox();
    const w = window as unknown as { headRan?: boolean; bodyRan?: boolean };
    expect([w.headRan, w.bodyRan]).toEqual([undefined, undefined]);
    expect(window.document.documentElement.lang).toBe("fr");
    expect(window.document.querySelector("style[data-component]")).not.toBeNull();
    expect(window.document.querySelector("[data-redline-sandbox-stage]")!.children).toHaveLength(0);
    expect(window.document.querySelectorAll("body > ui-button")).toHaveLength(0);
  });

  it("tells the card the slots, the first instances' texts and where to look for states", async () => {
    const { messages } = await openSandbox();
    // Objects built in the artboard window: compared as plain data.
    const info = JSON.parse(JSON.stringify(messages.find((m) => m.type === "redline:sandbox-info"))) as Record<string, unknown>;
    expect(info.tag).toBe("ui-button");
    expect(info.defined).toBe(true);
    expect(info.slots).toEqual([
      { name: "icon", fallback: { text: "", rich: true, tag: "ui-icon" } },
      { name: "", fallback: { text: "", rich: false } },
      { name: "hint", label: "Aide", fallback: { text: "Aide par défaut", rich: false } },
    ]);
    expect(info.firstFills).toEqual({ "": { text: "Publier l'annonce", rich: false } });
    expect((info.sources as string[]).some((s) => s.includes("ui-button[open]"))).toBe(true);
  });

  it("builds the instance from the card's trial and builds it again on every change", async () => {
    const { window, set } = await openSandbox();
    set({ values: { variant: "ghost", fullWidth: true }, states: { open: true }, slots: { "": "Enregistrer", hint: "Astuce", icon: "" } });
    let instance = window.document.getElementById("redline-sandbox")!;
    expect(instance.localName).toBe("ui-button");
    expect([instance.getAttribute("variant"), instance.hasAttribute("fullwidth"), instance.hasAttribute("open")]).toEqual(["ghost", true, true]);
    expect(instance.querySelector("button")!.textContent).toBe("★EnregistrerAstuce");
    set({ values: { variant: "primary", fullWidth: false }, slots: { "": "" } });
    instance = window.document.getElementById("redline-sandbox")!;
    expect([instance.getAttribute("variant"), instance.hasAttribute("fullwidth"), instance.hasAttribute("open")]).toEqual(["primary", false, false]);
    expect(instance.querySelector("button")!.textContent).toBe("★Aide par défaut");
    expect(window.document.querySelectorAll("ui-button")).toHaveLength(1);
  });

  it("refuses a file that is not a component", async () => {
    await openSandbox("components/icon.html");
    const ds = (await (await server.get("/api/design-systems")).json()) as DesignSystem[];
    const res = await fetch(`${server.artboardOrigin}/pages/${ds[0]!.pageId}/index.html?sandbox=1`);
    expect(res.status).toBe(404);
  });
});

describe("sandbox document of an unusual file", () => {
  it("reads a file without a body tag, and keeps the theme attributes of html and body but not the body's layout", async () => {
    const { sandboxDocument } = await import("../src/sandbox.js");
    const bare = sandboxDocument(`<html><template data-component><b><slot></slot></b></template><ui-x>Texte</ui-x></html>`, "ui-x");
    expect(bare).toContain(`<template data-redline-sandbox-source><template data-component><b><slot></slot></b></template><ui-x>Texte</ui-x></template>`);
    const themed = sandboxDocument(`<!doctype html><html lang="fr" data-theme="dark"><head></head><body class="dark" style="display:grid" data-density="compact"><ui-x></ui-x></body></html>`, "ui-x");
    expect(themed).toContain(`<html lang="fr" data-theme="dark">`);
    expect(themed).toContain(`<body class="dark" data-density="compact">`);
  });
});
