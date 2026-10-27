import { afterEach, beforeEach, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Page, Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const ARTBOARD = `<!doctype html><html><body><p id="text">Hello</p><ul id="list" style="overflow-y:auto;height:100px"><li id="item">One</li></ul></body></html>`;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let server: TestServer;
let bridgeSource: string;

beforeEach(async () => {
  server = await startTestServer();
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, { title: "P", files: { "home.html": ARTBOARD } })
  ).json()) as Page;
  const html = await (await fetch(`${server.artboardOrigin}/pages/${page.id}/home.html`)).text();
  const src = /<script src="([^"]+bridge\.js)"><\/script>/.exec(html)![1]!;
  bridgeSource = await (await fetch(new URL(src, server.artboardOrigin))).text();
});
afterEach(async () => {
  await server.stop();
});

function load() {
  const { window } = new JSDOM(ARTBOARD, { runScripts: "outside-only" });
  const wheels: Record<string, unknown>[] = [];
  window.addEventListener("message", (e) => {
    const data = e.data as { type: string };
    if (data.type === "redline:wheel") wheels.push(data);
  });
  window.eval(bridgeSource);
  const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: window }));
  const wheel = (init: WheelEventInit, target = "text") => {
    const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    window.document.getElementById(target)!.dispatchEvent(event);
    return event;
  };
  // jsdom has no layout: give the list 300px of content in its 100px box, scrolled to `top`.
  const scrollList = (top: number) => {
    const list = window.document.getElementById("list")!;
    Object.defineProperty(list, "scrollHeight", { value: 300, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    list.scrollTop = top;
  };
  return { window, wheels, post, wheel, scrollList };
}

it("forwards wheel and pinch gestures to the canvas once the canvas asks for them", async () => {
  const { wheels, post, wheel } = load();
  post({ type: "redline:set-mode", picking: false, forwardWheel: true });
  const pan = wheel({ deltaX: 4, deltaY: -12, clientX: 30, clientY: 40 });
  const pinch = wheel({ deltaY: 3, ctrlKey: true, clientX: 10, clientY: 20 });
  await flush();
  expect(wheels).toEqual([
    { type: "redline:wheel", deltaX: 4, deltaY: -12, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 30, clientY: 40 },
    { type: "redline:wheel", deltaX: 0, deltaY: 3, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 10, clientY: 20 },
  ]);
  expect(pan.defaultPrevented).toBe(true);
  expect(pinch.defaultPrevented).toBe(true);
});

it("leaves the wheel to the artboard when no canvas asked for it (play mode, previews)", async () => {
  const { wheels, post, wheel } = load();
  const before = wheel({ deltaY: 10 });
  post({ type: "redline:set-mode", picking: true });
  const after = wheel({ deltaY: 10 });
  await flush();
  expect(wheels).toEqual([]);
  expect(before.defaultPrevented).toBe(false);
  expect(after.defaultPrevented).toBe(false);
});

it("lets a scroll area of the artboard take the wheel until it reaches its end, but always forwards a pinch", async () => {
  const { wheels, post, wheel, scrollList } = load();
  post({ type: "redline:set-mode", picking: false, forwardWheel: true });
  scrollList(0);
  const down = wheel({ deltaY: 10 }, "item");
  const upAtTop = wheel({ deltaY: -10 }, "item");
  const pinch = wheel({ deltaY: 2, ctrlKey: true }, "item");
  scrollList(200);
  const downAtEnd = wheel({ deltaY: 10 }, "item");
  await flush();
  expect(down.defaultPrevented).toBe(false);
  expect([upAtTop, pinch, downAtEnd].map((e) => e.defaultPrevented)).toEqual([true, true, true]);
  expect(wheels.map((w) => w.deltaY)).toEqual([-10, 2, 10]);
});

it("converts a wheel counted in lines into pixels", async () => {
  const { wheels, post, wheel } = load();
  post({ type: "redline:set-mode", picking: false, forwardWheel: true });
  wheel({ deltaY: 3, deltaMode: 1 });
  await flush();
  expect(wheels[0]).toMatchObject({ deltaY: 48, deltaMode: 0 });
});

it("keeps a drag on the canvas from selecting the artboard's text, but not in play mode", async () => {
  const { window, post } = load();
  const selectStart = () => {
    const event = new window.Event("selectstart", { bubbles: true, cancelable: true });
    window.document.getElementById("text")!.firstChild!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(selectStart()).toBe(false);
  post({ type: "redline:set-mode", picking: false, forwardWheel: true });
  await flush();
  expect(selectStart()).toBe(true);
});
