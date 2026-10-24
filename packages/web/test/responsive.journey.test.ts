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
          artboards: [{ file: "landing.html", x: 0, y: 0, device: "phone", responsive: ["desktop", "tablet", { device: "mobile", width: 390, height: 844 }] }],
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
  expect(await tab.locator("[data-canvas-arrow] > path").getAttribute("d")).toBe(`M${width} ${height / 2} L5000 0`);

  // a tweak reaches every rendering
  await tab.getByRole("button", { name: "Tweaks", exact: true }).click();
  await tab.getByRole("button", { name: "grid" }).click();
  for (const index of [0, 1, 2]) {
    await expect.poll(() => tab.locator("[data-rendering] iframe").nth(index).contentFrame().locator("html").getAttribute("data-tweak-layout")).toBe("grid");
  }
}, 60_000);
