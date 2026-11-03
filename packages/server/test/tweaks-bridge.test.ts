import { afterEach, beforeEach, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const ARTBOARD = `<!doctype html><html><body><h1>Hello</h1></body></html>`;

let server: TestServer;
let bridgeSource: string;

beforeEach(async () => {
  server = await startTestServer();
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, { title: "P", files: { "home.html": ARTBOARD } })
  ).json()) as Page;
  const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
  const src = /<script src="([^"]+bridge\.js[^"]*)"><\/script>/.exec(html)![1]!;
  bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
});
afterEach(async () => {
  await server.stop();
});

function load() {
  const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
  window.eval(bridgeSource);
  const root = window.document.documentElement;
  const events: unknown[] = [];
  window.addEventListener("redline:tweaks", (e) => events.push((e as CustomEvent).detail));
  const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window.parent }));
  return { window, root, events, post };
}

it("exposes tweak values to the artboard as CSS variables, data attributes, an event and a global", () => {
  const { window, root, events, post } = load();
  const values = { accent: "#0f766e", search: true, gap: 12, title: "Hi there" };
  post({ type: "redline:set-tweaks", values });

  expect(root.style.getPropertyValue("--tweak-accent")).toBe("#0f766e");
  expect(root.style.getPropertyValue("--tweak-gap")).toBe("12");
  expect(root.style.getPropertyValue("--tweak-search")).toBe("1");
  expect(root.getAttribute("data-tweak-accent")).toBe("#0f766e");
  expect(root.getAttribute("data-tweak-search")).toBe("true");
  expect(root.getAttribute("data-tweak-title")).toBe("Hi there");
  expect(events).toEqual([values]);
  expect((window as unknown as { redlineTweaks: unknown }).redlineTweaks).toEqual(values);
});

it("replaces the previous values when new ones arrive", () => {
  const { root, post } = load();
  post({ type: "redline:set-tweaks", values: { accent: "#fff", gap: 1 } });
  post({ type: "redline:set-tweaks", values: { accent: "#000" } });
  expect(root.style.getPropertyValue("--tweak-accent")).toBe("#000");
  expect(root.hasAttribute("data-tweak-gap")).toBe(false);
  expect(root.style.getPropertyValue("--tweak-gap")).toBe("");
});
