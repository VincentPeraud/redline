import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { RESPONSIVE_SPACING, type Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const LANDING = `<!doctype html><html><head><style>
  body { margin: 0 } .page { height: 1100px; background: #eee }
  @media (max-width: 500px) { .page { height: 2400px } }
</style></head><body><div class="page">Landing</div></body></html>`;

it("lays a responsive artboard out as one frame: renderings side by side at the real height of their page, one strip, one set of buttons, tweaks on every rendering, arrows on the whole frame", async () => {
  const project = (await (await server.post("/api/projects", { title: "Responsive" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: {
        "landing.html": LANDING,
        "manifest.json": JSON.stringify({
          artboards: [{ file: "landing.html", x: 0, y: 0, frame: "phone", responsive: ["desktop", "tablet", { format: "mobile", width: 390, height: 844 }] }],
          elements: [{ kind: "arrow", from: "landing.html", to: { x: 5000, y: 0 } }],
          tweaks: [{ id: "layout", type: "choice", label: "Layout", options: ["list", "grid"] }],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);

  const frames = tab.locator("[data-rendering] iframe");
  await frames.nth(2).waitFor();
  await expect.poll(() => frames.evaluateAll((els) => els.map((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight]))).toEqual([
    [1440, 1100],
    [768, 1100],
    [390, 2400],
  ]);

  const frame = tab.locator("[data-responsive-frame]");
  const S = RESPONSIVE_SPACING;
  expect(await frame.evaluate((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight])).toEqual([4 * S + 1440 + 768 + 390, 2 * S + 2400]);
  expect(await tab.locator("[data-rendering]").evaluateAll((els) => els.map((el) => (el.firstElementChild as HTMLElement).textContent))).toEqual(["Desktop · 1440", "Tablette · 768", "Mobile · 390"]);
  expect(await tab.getByText("page de 2 400 px").count()).toBe(1);

  // one strip, one set of buttons
  expect(await tab.getByText("responsive", { exact: true }).count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Historique de landing.html" }).count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Lancer landing.html en plein écran" }).count()).toBe(1);

  // the arrow leaves the whole frame, not one rendering
  const width = 4 * S + 1440 + 768 + 390;
  const height = 2 * S + 2400;
  expect(await tab.locator("[data-canvas-arrow] > path").getAttribute("d")).toMatch(new RegExp(`^M${width} ${height / 2} C[\\d. ]+ 5000 0$`));

  // a tweak reaches every rendering
  await tab.getByRole("button", { name: "Tweaks", exact: true }).click();
  await tab.getByRole("button", { name: "grid" }).click();
  for (const index of [0, 1, 2]) {
    await expect.poll(() => tab.locator("[data-rendering] iframe").nth(index).contentFrame().locator("html").getAttribute("data-tweak-layout")).toBe("grid");
  }
}, 60_000);

it("pins a comment in one rendering: its pin shows in that rendering only (after a reload too) and the comments panel labels it with a chip", async () => {
  const project = (await (await server.post("/api/projects", { title: "Pins" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: {
        "landing.html": `<!doctype html><html><body style="margin:0"><h1 style="margin:0">Landing</h1></body></html>`,
        "plain.html": `<!doctype html><html><body style="margin:0"><h1 style="margin:0">Plain</h1></body></html>`,
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "landing.html", x: 0, y: 0, responsive: ["desktop", { format: "mobile", width: 390, height: 844 }] },
            { file: "plain.html", x: 6000, y: 0, width: 400, height: 300 },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const mobile = tab.locator("[data-rendering=mobile-390]");
  const desktop = tab.locator("[data-rendering=desktop-1440]");
  await mobile.locator("iframe").waitFor();
  await expect.poll(() => mobile.locator("iframe").contentFrame().locator("h1").count()).toBe(1);

  await tab.keyboard.press("c");
  await mobile.locator("iframe").contentFrame().locator("h1").click();
  await tab.locator("#new-comment").fill("Burger menu");
  await tab.locator("#new-comment").press("Enter");

  const pins = (rendering: typeof mobile) => rendering.locator("[data-pin]");
  await expect.poll(() => pins(mobile).count()).toBe(1);
  expect(await pins(desktop).count()).toBe(0);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  expect(await tab.getByTestId("thread-rendering").allTextContents()).toEqual(["Mobile · 390"]);

  await tab.reload();
  await expect.poll(() => pins(mobile).count()).toBe(1);
  expect(await pins(desktop).count()).toBe(0);

  // a comment on a plain artboard carries no chip
  await tab.keyboard.press("c");
  await tab.locator("iframe[title$='plain.html']").contentFrame().locator("h1").click({ force: true });
  await tab.locator("#new-comment").fill("Plain comment");
  await tab.locator("#new-comment").press("Enter");
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(2);
  expect(await tab.getByTestId("thread-rendering").count()).toBe(1);
}, 60_000);

it("hides renderings from the strip chips and the Rendus menu: counts hidden threads, keeps one rendering, keeps older threads in the first shown one, survives a reload and creates no version", async () => {
  const project = (await (await server.post("/api/projects", { title: "Hide" })).json()) as { id: string };
  const html = `<!doctype html><html><body style="margin:0"><h1 style="margin:0">Landing</h1></body></html>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      files: {
        "landing.html": html,
        "manifest.json": JSON.stringify({ artboards: [{ file: "landing.html", x: 0, y: 0, responsive: ["desktop", "tablet", "mobile"] }] }),
      },
    })
  ).json()) as Page;
  const pin = { artboard: "landing.html", selector: "body > h1", xPct: 10, yPct: 10 };
  await server.post(`/api/pages/${page.id}/threads`, { ...pin, body: "On mobile", rendering: { format: "mobile", width: 390 } });
  await server.post(`/api/pages/${page.id}/threads`, { ...pin, body: "Older thread" });
  const versionCount = async () => ((await (await server.get(`/api/pages/${page.id}/versions`)).json()) as unknown[]).length;
  const versionsBefore = await versionCount();

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const rendering = (key: string) => tab.locator(`[data-rendering=${key}]`);
  const chips = tab.getByRole("group", { name: "Rendus affichés sur le canvas" });
  const chip = (name: RegExp | string) => chips.getByRole("button", { name });
  await rendering("mobile-390").locator("iframe").waitFor();

  // the older thread (no rendering) sits in the first rendering
  await expect.poll(() => rendering("desktop-1440").locator("[data-pin]").count()).toBe(1);
  await expect.poll(() => rendering("mobile-390").locator("[data-pin]").count()).toBe(1);

  // a chip hides its rendering and says how many threads that hides
  expect(await chips.getByRole("button").count()).toBe(3);
  await chip("Mobile").click();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(2);
  expect(await chip(/Mobile/).textContent()).toBe("Mobile · 1 fil masqué");
  expect(await chip(/Mobile/).getAttribute("aria-pressed")).toBe("false");
  const S = RESPONSIVE_SPACING;
  expect(await tab.locator("[data-responsive-frame]").evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(3 * S + 1440 + 768);

  // it survives a reload, on the server
  await tab.reload();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(2);
  expect(await chip(/Mobile/).textContent()).toBe("Mobile · 1 fil masqué");

  // the last shown rendering cannot be hidden; the older thread follows the first one shown
  await chip("Desktop").click();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(1);
  await chip("Tablette").click();
  expect(await chip("Tablette").getAttribute("aria-pressed")).toBe("true");
  expect(await tab.locator("[data-rendering]").count()).toBe(1);
  await expect.poll(() => rendering("tablet-768").locator("[data-pin]").count()).toBe(1);
  await chip("Desktop").click();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(2);

  // the Rendus menu: a global choice applies to the format in every frame and resets the chip's exception
  const menuButton = tab.getByRole("button", { name: /^Rendus/ });
  await menuButton.click();
  const menu = tab.getByRole("group", { name: "Rendus affichés sur toute la page" });
  expect(await menu.getByRole("checkbox").count()).toBe(3);
  // the menu follows the global choice, not the frame's exception
  expect(await menu.getByRole("checkbox", { name: /Mobile/ }).isChecked()).toBe(true);
  await menu.getByRole("checkbox", { name: /Tablette/ }).uncheck();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(1);
  expect(await menuButton.textContent()).toBe("Rendus · 1 masqué");
  await menu.getByRole("checkbox", { name: /Tablette/ }).check();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(2);
  // a chip exception, then the global choice for that format clears it
  await chip("Mobile").click();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(3);
  await chip("Tablette").click();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(2);
  await menu.getByRole("checkbox", { name: /Tablette/ }).uncheck();
  await menu.getByRole("checkbox", { name: /Tablette/ }).check();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(3);

  await tab.reload();
  await expect.poll(() => tab.locator("[data-rendering]").count()).toBe(3);
  expect(await versionCount()).toBe(versionsBefore);
}, 60_000);

it("shows no Rendus menu on a page without a responsive artboard", async () => {
  const project = (await (await server.post("/api/projects", { title: "Plain" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Plain", files: { "a.html": "<h1>A</h1>" } })).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: /Guides/ }).waitFor();
  expect(await tab.getByRole("button", { name: /^Rendus/ }).count()).toBe(0);
}, 60_000);

it("shows the artboard's guides in every rendering when guides are toggled", async () => {
  const project = (await (await server.post("/api/projects", { title: "Responsive guides" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Guides",
      files: {
        "landing.html": `<!doctype html><html><body style="margin:0"><h1>Landing</h1></body></html>`,
        "manifest.json": JSON.stringify({
          artboards: [{ file: "landing.html", responsive: ["desktop", "mobile"], guides: { columns: 12, gutter: 24, margin: 80 } }],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-rendering] iframe").first().waitFor();
  const columns = tab.locator("[data-rendering] [data-guide-column]");
  expect(await columns.count()).toBe(0);
  await tab.getByRole("button", { name: "Guides (G)" }).click();
  expect(await columns.count()).toBe(24);
  await tab.close();
}, 60_000);
