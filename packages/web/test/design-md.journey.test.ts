import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DesignMdResponse, Project } from "@redline/shared";
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

it("edits and saves DESIGN.md and adds an asset from the DESIGN.md screen", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  await tab.getByRole("link", { name: "DESIGN.md" }).click();

  const editor = tab.getByLabel("DESIGN.md content");
  const save = tab.getByRole("button", { name: "Save" });
  await editor.waitFor();
  expect(await save.isDisabled()).toBe(true);

  await editor.fill("# Acme\n- One action per screen");
  expect(await tab.getByTestId("design-md-status").textContent()).toBe("Unsaved changes");
  await save.click();
  await expect
    .poll(async () => ((await (await server.get(`/api/projects/${project.id}/design-md`)).json()) as DesignMdResponse).content)
    .toBe("# Acme\n- One action per screen");
  expect(await tab.getByTestId("design-md-status").textContent()).toBe("Saved");

  await tab.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await expect.poll(async () => tab.getByTestId("assets").textContent()).toContain("logo.png");
  await tab.close();
});
