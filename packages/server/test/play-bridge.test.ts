import { afterEach, beforeEach, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const ARTBOARD = `<!doctype html><html><body>
  <button id="buy"><span id="label">Buy</span></button><a id="other" href="#">Other</a>
</body></html>`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let server: TestServer;
let bridgeSource: string;

beforeEach(async () => {
  server = await startTestServer();
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, { title: "P", type: "prototype", files: { "home.html": ARTBOARD } })
  ).json()) as Page;
  const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
  const src = /<script src="([^"]+)"><\/script>/.exec(html)![1]!;
  bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
});
afterEach(async () => {
  await server.stop();
});

function load() {
  const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
  const links: string[] = [];
  window.addEventListener("message", (e) => {
    const data = e.data as { type: string; selector?: string };
    if (data.type === "redline:link") links.push(data.selector!);
  });
  window.eval(bridgeSource);
  const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
  const click = (id: string) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    window.document.getElementById(id)!.dispatchEvent(event);
    return event;
  };
  return { links, post, click };
}

it("reports the matching link selector when a linked element, or a child of it, is clicked", async () => {
  const { links, post, click } = load();
  post({ type: "redline:set-links", selectors: ["#buy"] });
  const event = click("label");
  await flush();
  expect(links).toEqual(["#buy"]);
  expect(event.defaultPrevented).toBe(true);
});

it("ignores clicks on elements that are not linked, and does nothing before links are set", async () => {
  const { links, post, click } = load();
  click("buy");
  post({ type: "redline:set-links", selectors: ["#buy"] });
  const event = click("other");
  await flush();
  expect(links).toEqual([]);
  expect(event.defaultPrevented).toBe(false);
});

it("survives an invalid link selector and stops reporting once links are cleared", async () => {
  const { links, post, click } = load();
  post({ type: "redline:set-links", selectors: ["!!", "#buy"] });
  click("buy");
  post({ type: "redline:set-links", selectors: null });
  click("buy");
  await flush();
  expect(links).toEqual(["#buy"]);
});
