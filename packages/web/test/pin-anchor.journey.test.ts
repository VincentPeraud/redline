import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({ artboards: [{ file: "a.html", title: "Planifier", x: 0, y: 0, width: 600, height: 600 }] });
const block = (label: string) => `<div style="height:200px;margin-left:100px;width:300px"><label>${label}</label></div>`;
const formOf = (...labels: string[]) => `<!doctype html><body style="margin:0;font-family:sans-serif"><form>${labels.map(block).join("")}</form></body>`;

it("pins a comment on its element's corner, follows the element when the page moves it, and says when it is gone", async () => {
  const project = (await (await server.post("/api/projects", { title: "Radio" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Sorties", files: { "manifest.json": MANIFEST, "a.html": formOf("Nom", "Plan de vol") } })).json()) as Page;
  const created = (await (
    await server.post(`/api/pages/${page.id}/threads`, {
      artboard: "a.html",
      selector: "body > form > div:nth-of-type(2)",
      xPct: 1,
      yPct: 1,
      elementName: "bloc « Plan de vol »",
      body: "Put the flight plan first",
    })
  ).json()) as Thread;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const pin = tab.locator(`[data-pin-thread="${created.id}"]`);
  const frame = tab.locator("iframe").first();
  const pinAt = async () => {
    const [p, f] = [(await pin.boundingBox())!, (await frame.boundingBox())!];
    return { x: (p.x + p.width - f.x) / f.width, y: (p.y - f.y) / f.height };
  };
  await expect.poll(async () => (await pinAt()).y, { timeout: 10_000 }).toBeCloseTo(200 / 600, 2);
  expect((await pinAt()).x).toBeCloseTo(400 / 600, 2);

  await server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": MANIFEST, "a.html": formOf("Plan de vol", "Nom") }, message: "Flight plan first", origin: "thread" });
  await tab.reload();
  await expect.poll(async () => (await pinAt()).y, { timeout: 10_000 }).toBeCloseTo(0, 2);

  await server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": MANIFEST, "a.html": formOf("Nom", "Date") }, message: "Drop flight plan", origin: "thread" });
  await tab.reload();
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const card = tab.locator(`[data-thread="${created.id}"]`);
  await card.getByTestId("thread-element-lost").waitFor();
  expect(await card.getByTestId("thread-element-lost").textContent()).toBe("élément introuvable");
  await tab.close();
}, 90_000);
